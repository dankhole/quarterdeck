import { describe, expect, it, vi } from "vitest";

import type { AbandonedManagedProcess } from "../../../src/terminal/managed-process-ownership";
import { findOrphanedAgentPids, killOrphanedAgentProcesses } from "../../../src/terminal/orphan-cleanup";

function createManagedCandidate(pid: number, creationTime = "638920000000000000"): AbandonedManagedProcess {
	return {
		identity: { pid, creationTime },
		records: [{ recordId: "12345678-1234-1234-1234-123456789abc", path: `/state/${pid}.json` }],
	};
}

describe("findOrphanedAgentPids", () => {
	it("finds orphaned Claude and Codex processes from Unix ps output", async () => {
		const pids = await findOrphanedAgentPids({
			platform: "linux",
			runPsCommand: async () => ({
				ok: true,
				stdout: [
					" 100 1 /usr/local/bin/codex",
					" 101 1 claude",
					" 102 2 codex",
					` ${process.pid} 1 codex`,
					" 103 1 node",
				].join("\n"),
			}),
		});

		expect(pids).toEqual([100, 101]);
	});

	it("uses only launch-scoped ownership records on Windows", async () => {
		const pids = await findOrphanedAgentPids({
			platform: "win32",
			findManagedProcesses: async () => [createManagedCandidate(300)],
			runPsCommand: async () => ({
				ok: true,
				stdout: JSON.stringify([
					{ pid: 301, command: "claude.exe" },
					{ pid: 302, command: "node.exe", commandLine: "codex.js" },
					{ pid: 303, command: "cmd.exe", commandLine: "pi.cmd" },
					{ pid: 304, command: "powershell.exe", commandLine: "claude" },
				]),
			}),
		});

		expect(pids).toEqual([300]);
	});

	it("returns no pids when Unix ps fails", async () => {
		const pids = await findOrphanedAgentPids({
			platform: "linux",
			runPsCommand: async () => ({
				ok: false,
				stdout: "ps failed",
			}),
		});

		expect(pids).toEqual([]);
	});
});

describe("killOrphanedAgentProcesses", () => {
	it("awaits async Unix orphan discovery before killing pids", async () => {
		let resolvePids: (pids: number[]) => void = () => {
			throw new Error("orphan discovery did not start");
		};
		const pendingPids = new Promise<number[]>((resolve) => {
			resolvePids = resolve;
		});
		const killed: number[] = [];
		const cleanup = killOrphanedAgentProcesses({
			platform: "linux",
			findPids: async () => await pendingPids,
			killProcess: async (pid) => {
				killed.push(pid);
				return true;
			},
		});

		await Promise.resolve();
		expect(killed).toEqual([]);
		resolvePids([200, 201]);

		await expect(cleanup).resolves.toBe(2);
		expect(killed).toEqual([200, 201]);
	});

	it("reverifies creation evidence before terminating a managed Windows tree", async () => {
		const candidate = createManagedCandidate(300);
		const killed: Array<{ pid: number; signal: string | number | undefined }> = [];
		const retired: string[] = [];

		await expect(
			killOrphanedAgentProcesses({
				platform: "win32",
				findManagedProcesses: async () => [candidate],
				verifyManagedProcess: async (received) => received === candidate,
				retireManagedProcess: async (handle) => {
					retired.push(handle.path);
				},
				killProcessTree: (pid, signal, callback) => {
					killed.push({ pid, signal });
					callback?.();
				},
			}),
		).resolves.toBe(1);

		expect(killed).toEqual([{ pid: 300, signal: "SIGTERM" }]);
		expect(retired).toEqual(["/state/300.json"]);
	});

	it("never signals a Windows PID whose creation identity changed", async () => {
		const candidate = createManagedCandidate(300);
		const killProcess = vi.fn(async () => true);
		const retireManagedProcess = vi.fn(async () => undefined);

		await expect(
			killOrphanedAgentProcesses({
				platform: "win32",
				findManagedProcesses: async () => [candidate],
				verifyManagedProcess: async () => false,
				killProcess,
				retireManagedProcess,
			}),
		).resolves.toBe(0);

		expect(killProcess).not.toHaveBeenCalled();
		expect(retireManagedProcess).toHaveBeenCalledWith(candidate.records[0]);
	});
});
