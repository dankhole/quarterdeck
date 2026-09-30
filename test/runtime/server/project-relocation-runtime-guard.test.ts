import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeDiagnosticInstance } from "../../../src/diagnostics/runtime-instance";
import { assertProjectRelocationRuntimeIsExclusive } from "../../../src/server/project-relocation-runtime-guard";

describe("project relocation runtime exclusion", () => {
	let stateHome: string;
	beforeEach(async () => {
		stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-relocation-runtime-"));
		vi.stubEnv("QUARTERDECK_STATE_HOME", stateHome);
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(stateHome, { recursive: true, force: true });
	});

	async function createInstance() {
		return await RuntimeDiagnosticInstance.create({
			stateHome,
			host: "127.0.0.1",
			port: 3500,
			quarterdeckVersion: "0.12.9",
		});
	}

	it("accepts the current instance and finalized instances", async () => {
		const current = await createInstance();
		const stopped = await createInstance();
		await stopped.markStopped();
		const failed = await createInstance();
		await failed.markFailed("TestFailure");
		await expect(
			assertProjectRelocationRuntimeIsExclusive(current.getPublicDescriptor().runtimeInstanceId),
		).resolves.toBeUndefined();
	});

	it("rejects another live runtime throughout startup, normal operation, and shutdown", async () => {
		const current = await createInstance();
		const other = await createInstance();
		const currentId = current.getPublicDescriptor().runtimeInstanceId;
		await expect(assertProjectRelocationRuntimeIsExclusive(currentId)).rejects.toThrow("Stop the other runtime");
		await other.markReady("127.0.0.1", 3501);
		await expect(assertProjectRelocationRuntimeIsExclusive(currentId)).rejects.toThrow("Stop the other runtime");
		await other.markStopping();
		await expect(assertProjectRelocationRuntimeIsExclusive(currentId)).rejects.toThrow("Stop the other runtime");
	});

	it("ignores a stale descriptor after its process has exited", async () => {
		const current = await createInstance();
		const stale = await createInstance();
		await writeFile(stale.descriptorPath, JSON.stringify({ ...stale.getDescriptor(), pid: 2_000_000_000 }));
		await expect(
			assertProjectRelocationRuntimeIsExclusive(current.getPublicDescriptor().runtimeInstanceId),
		).resolves.toBeUndefined();
	});
});
