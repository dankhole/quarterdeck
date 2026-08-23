import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverRuntimeDiagnosticInstances, RuntimeDiagnosticInstance } from "../../../src/diagnostics";

describe("runtime diagnostic discovery", () => {
	let stateHome: string;

	beforeEach(async () => {
		stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-diagnostics-instance-"));
	});

	afterEach(async () => {
		await rm(stateHome, { recursive: true, force: true });
	});

	it("persists a private token while exposing only the public descriptor", async () => {
		const instance = await RuntimeDiagnosticInstance.create({
			stateHome,
			host: "127.0.0.1",
			port: 3_500,
			quarterdeckVersion: "1.2.3",
		});
		const privateDescriptor = instance.getDescriptor();
		const publicDescriptor = instance.getPublicDescriptor();
		expect(privateDescriptor.diagnosticToken.length).toBeGreaterThan(30);
		expect("diagnosticToken" in publicDescriptor).toBe(false);
		expect(instance.verifyToken(privateDescriptor.diagnosticToken)).toBe(true);
		expect(instance.verifyToken(`${privateDescriptor.diagnosticToken}x`)).toBe(false);
		const onDisk = JSON.parse(await readFile(instance.descriptorPath, "utf8")) as Record<string, unknown>;
		expect(onDisk.diagnosticToken).toBe(privateDescriptor.diagnosticToken);
	});

	it("tracks startup, readiness, stopping, and finalization for discovery", async () => {
		const instance = await RuntimeDiagnosticInstance.create({
			stateHome,
			host: "127.0.0.1",
			port: 3_500,
			quarterdeckVersion: "1.2.3",
		});
		expect((await discoverRuntimeDiagnosticInstances(stateHome))[0]?.descriptor.status).toBe("starting");
		await instance.markReady("127.0.0.1", 4545);
		expect((await discoverRuntimeDiagnosticInstances(stateHome))[0]).toMatchObject({
			pidAlive: true,
			descriptor: { status: "ready", port: 4545 },
		});
		await instance.markStopping();
		expect((await discoverRuntimeDiagnosticInstances(stateHome))[0]?.descriptor.status).toBe("stopping");
		await instance.markStopped();
		expect((await discoverRuntimeDiagnosticInstances(stateHome))[0]?.descriptor.status).toBe("stopped");
	});

	it("persists only a stable failure class in private and public descriptors", async () => {
		const instance = await RuntimeDiagnosticInstance.create({
			stateHome,
			host: "127.0.0.1",
			port: 3_500,
			quarterdeckVersion: "1.2.3",
		});
		await instance.markFailed("sentinel private startup failure");

		expect(instance.getDescriptor().failure).toBe("UnknownError");
		expect(instance.getPublicDescriptor().failure).toBe("UnknownError");
		expect(JSON.stringify(instance.getPublicDescriptor())).not.toContain("sentinel private");
	});

	it("retains only the newest three dead instances, including unfinalized crash descriptors", async () => {
		for (let index = 0; index < 4; index += 1) {
			const instance = await RuntimeDiagnosticInstance.create({
				stateHome,
				host: "127.0.0.1",
				port: 3_500 + index,
				quarterdeckVersion: "1.2.3",
			});
			const descriptor = instance.getDescriptor();
			await writeFile(
				instance.descriptorPath,
				`${JSON.stringify({
					...descriptor,
					status: "ready",
					pid: 2_000_000_000 + index,
					startedAt: new Date(1_000 + index).toISOString(),
					readyAt: new Date(2_000 + index).toISOString(),
				})}\n`,
				{ encoding: "utf8", mode: 0o600 },
			);
		}

		const active = await RuntimeDiagnosticInstance.create({
			stateHome,
			host: "127.0.0.1",
			port: 4_000,
			quarterdeckVersion: "1.2.3",
		});
		const discovered = await discoverRuntimeDiagnosticInstances(stateHome);
		expect(discovered).toHaveLength(4);
		expect(discovered.filter((instance) => !instance.pidAlive)).toHaveLength(3);
		expect(
			discovered.some(
				(instance) => instance.descriptor.runtimeInstanceId === active.getDescriptor().runtimeInstanceId,
			),
		).toBe(true);
	});

	it("degrades to an in-memory descriptor when the state path is unwritable", async () => {
		const blockedStateHome = join(stateHome, "not-a-directory");
		await writeFile(blockedStateHome, "blocked", "utf8");
		const failures: Error[] = [];
		const instance = await RuntimeDiagnosticInstance.create({
			stateHome: blockedStateHome,
			host: "127.0.0.1",
			port: 3_500,
			quarterdeckVersion: "1.2.3",
			onPersistenceFailure: (error) => failures.push(error),
		});

		expect(instance.getPersistenceHealth()).toMatchObject({ persistent: false, failureClass: "ENOTDIR" });
		expect(failures).toHaveLength(1);
		expect(await discoverRuntimeDiagnosticInstances(blockedStateHome)).toEqual([]);

		await rm(blockedStateHome);
		await mkdir(blockedStateHome);
		await expect(instance.markReady("127.0.0.1", 4_545)).resolves.toBeUndefined();
		expect(instance.getPersistenceHealth()).toEqual({ persistent: true, failureClass: null });
		expect((await discoverRuntimeDiagnosticInstances(blockedStateHome))[0]?.descriptor.status).toBe("ready");
	});
});
