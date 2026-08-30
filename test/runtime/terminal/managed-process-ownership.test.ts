import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	_testing,
	discoverAbandonedManagedProcesses,
	ManagedProcessOwnershipError,
	registerManagedProcessOwnership,
	verifyAbandonedManagedProcess,
	type WindowsProcessSnapshotRunner,
} from "../../../src/terminal/managed-process-ownership";

interface SnapshotIdentity {
	pid: number;
	parentPid: number;
	creationTime: string;
}

const OWNER: SnapshotIdentity = { pid: 100, parentPid: 1, creationTime: "638920000000000100" };
const ROOT: SnapshotIdentity = { pid: 200, parentPid: 100, creationTime: "638920000000000200" };

function snapshotRunner(
	resolve: (pids: readonly number[] | undefined) => SnapshotIdentity[],
): WindowsProcessSnapshotRunner {
	return async (pids) => ({ ok: true, stdout: JSON.stringify(resolve(pids)) });
}

describe("managed Windows process ownership", () => {
	const temporaryRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
	});

	async function createStateHome(): Promise<string> {
		const path = await mkdtemp(join(tmpdir(), "quarterdeck-managed-processes-"));
		temporaryRoots.push(path);
		return path;
	}

	async function ensureTestDirectory(path: string): Promise<void> {
		await mkdir(path, { recursive: true, mode: 0o700 });
	}

	async function register(
		stateHome: string,
		options: {
			recordId?: string;
			registrationSnapshot?: SnapshotIdentity[];
			discoverySnapshot?: SnapshotIdentity[];
		},
	) {
		let call = 0;
		const runProcessSnapshot = snapshotRunner(() => {
			call++;
			return call === 1
				? (options.registrationSnapshot ?? [OWNER, ROOT])
				: (options.discoverySnapshot ?? options.registrationSnapshot ?? [OWNER, ROOT]);
		});
		const recordId = options.recordId ?? randomUUID();
		const handle = await registerManagedProcessOwnership(ROOT.pid, recordId, {
			platform: "win32",
			stateHome,
			runtimePid: OWNER.pid,
			runProcessSnapshot,
			ensurePrivateRegistryDirectory: ensureTestDirectory,
		});
		if (!handle) throw new Error("Expected a managed process ownership record.");
		return { handle, recordId, runProcessSnapshot };
	}

	it("persists only exact runtime and root creation identities beneath the protected registry", async () => {
		const stateHome = await createStateHome();
		const calls: Array<readonly number[] | undefined> = [];
		const recordId = randomUUID();
		const handle = await registerManagedProcessOwnership(ROOT.pid, recordId, {
			platform: "win32",
			stateHome,
			runtimePid: OWNER.pid,
			runProcessSnapshot: snapshotRunner((pids) => {
				calls.push(pids);
				return [OWNER, ROOT];
			}),
			ensurePrivateRegistryDirectory: async (path, options) => {
				expect(options?.platform).toBe("win32");
				await ensureTestDirectory(path);
			},
		});

		expect(calls).toEqual([[OWNER.pid, ROOT.pid]]);
		expect(handle?.path).toBe(join(_testing.getRegistryPath(stateHome), `${recordId}.json`));
		const serialized = await readFile(handle?.path ?? "", "utf8");
		expect(JSON.parse(serialized)).toMatchObject({
			version: 1,
			recordId,
			ownerRuntime: { pid: OWNER.pid, creationTime: OWNER.creationTime },
			rootProcess: { pid: ROOT.pid, creationTime: ROOT.creationTime },
		});
		expect(serialized).not.toMatch(/command|claude|codex|powershell|node/iu);
	});

	it("discovers an exact root only after its recorded runtime owner is gone", async () => {
		const stateHome = await createStateHome();
		const { handle } = await register(stateHome, { discoverySnapshot: [ROOT] });
		const requestedSnapshots: Array<readonly number[] | undefined> = [];

		const candidates = await discoverAbandonedManagedProcesses({
			platform: "win32",
			stateHome,
			runtimePid: 999,
			runProcessSnapshot: snapshotRunner((pids) => {
				requestedSnapshots.push(pids);
				return [ROOT];
			}),
			ensurePrivateRegistryDirectory: ensureTestDirectory,
		});

		expect(requestedSnapshots).toEqual([[OWNER.pid, ROOT.pid]]);
		expect(candidates).toEqual([{ identity: { pid: ROOT.pid, creationTime: ROOT.creationTime }, records: [handle] }]);
	});

	it("skips records owned by any still-live Quarterdeck runtime", async () => {
		const stateHome = await createStateHome();
		await register(stateHome, {});

		await expect(
			discoverAbandonedManagedProcesses({
				platform: "win32",
				stateHome,
				runtimePid: 999,
				runProcessSnapshot: snapshotRunner(() => [OWNER, ROOT]),
				ensurePrivateRegistryDirectory: ensureTestDirectory,
			}),
		).resolves.toEqual([]);
	});

	it("includes the current runtime only for explicit shutdown cleanup", async () => {
		const stateHome = await createStateHome();
		const { handle } = await register(stateHome, {});
		const commonOptions = {
			platform: "win32" as const,
			stateHome,
			runtimePid: OWNER.pid,
			runProcessSnapshot: snapshotRunner(() => [OWNER, ROOT]),
			ensurePrivateRegistryDirectory: ensureTestDirectory,
		};

		await expect(discoverAbandonedManagedProcesses(commonOptions)).resolves.toEqual([]);
		await expect(
			discoverAbandonedManagedProcesses({ ...commonOptions, includeCurrentRuntime: true }),
		).resolves.toEqual([{ identity: { pid: ROOT.pid, creationTime: ROOT.creationTime }, records: [handle] }]);
	});

	it("rejects PID reuse and retires the stale record without authorizing a kill", async () => {
		const stateHome = await createStateHome();
		const { handle } = await register(stateHome, {});
		const reusedRoot = { ...ROOT, creationTime: "638920000000009999" };

		await expect(
			discoverAbandonedManagedProcesses({
				platform: "win32",
				stateHome,
				runtimePid: 999,
				runProcessSnapshot: snapshotRunner(() => [reusedRoot]),
				ensurePrivateRegistryDirectory: ensureTestDirectory,
			}),
		).resolves.toEqual([]);
		await expect(stat(handle.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("never turns malformed registry content into a cleanup candidate", async () => {
		const stateHome = await createStateHome();
		const registryPath = _testing.getRegistryPath(stateHome);
		await ensureTestDirectory(registryPath);
		const malformedPath = join(registryPath, `${randomUUID()}.json`);
		await writeFile(malformedPath, JSON.stringify({ pid: ROOT.pid, command: "claude.exe" }), "utf8");

		await expect(
			discoverAbandonedManagedProcesses({
				platform: "win32",
				stateHome,
				runtimePid: 999,
				runProcessSnapshot: snapshotRunner(() => [ROOT]),
				ensurePrivateRegistryDirectory: ensureTestDirectory,
			}),
		).resolves.toEqual([]);
		await expect(stat(malformedPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rechecks the exact creation identity immediately before cleanup", async () => {
		const candidate = {
			identity: { pid: ROOT.pid, creationTime: ROOT.creationTime },
			records: [],
		};
		await expect(
			verifyAbandonedManagedProcess(candidate, {
				platform: "win32",
				runProcessSnapshot: snapshotRunner(() => [ROOT]),
			}),
		).resolves.toBe(true);
		await expect(
			verifyAbandonedManagedProcess(candidate, {
				platform: "win32",
				runProcessSnapshot: snapshotRunner(() => [{ ...ROOT, creationTime: "638920000000009999" }]),
			}),
		).resolves.toBe(false);
	});

	it("fails closed when Windows process identity cannot be queried", async () => {
		const stateHome = await createStateHome();
		await expect(
			registerManagedProcessOwnership(ROOT.pid, randomUUID(), {
				platform: "win32",
				stateHome,
				runtimePid: OWNER.pid,
				runProcessSnapshot: async () => ({ ok: false, stdout: "" }),
				ensurePrivateRegistryDirectory: ensureTestDirectory,
			}),
		).rejects.toBeInstanceOf(ManagedProcessOwnershipError);
	});

	it("rejects a reused root PID that is not a direct child of the registering runtime", async () => {
		const stateHome = await createStateHome();
		const recordId = randomUUID();
		await expect(
			registerManagedProcessOwnership(ROOT.pid, recordId, {
				platform: "win32",
				stateHome,
				runtimePid: OWNER.pid,
				runProcessSnapshot: snapshotRunner(() => [{ ...ROOT, parentPid: 999 }, OWNER]),
				ensurePrivateRegistryDirectory: ensureTestDirectory,
			}),
		).rejects.toThrow("managed process was launched by the Quarterdeck runtime");
		await expect(stat(join(_testing.getRegistryPath(stateHome), `${recordId}.json`))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
