import { describe, expect, it } from "vitest";

import { findOrphanedAgentPids, killOrphanedAgentProcesses } from "../../../src/terminal/orphan-cleanup";

describe("findOrphanedAgentPids", () => {
	it("finds orphaned Claude and Codex processes from ps output", async () => {
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

	it("returns no pids when ps fails", async () => {
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
	it("awaits async orphan discovery before killing pids", async () => {
		let resolvePids: (pids: number[]) => void = () => {
			throw new Error("orphan discovery did not start");
		};
		const pendingPids = new Promise<number[]>((resolve) => {
			resolvePids = resolve;
		});
		const killed: number[] = [];
		const cleanup = killOrphanedAgentProcesses({
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
});
