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

	it("finds orphaned Windows agent processes from prefiltered process output", async () => {
		const pids = await findOrphanedAgentPids({
			platform: "win32",
			runPsCommand: async () => ({
				ok: true,
				stdout: JSON.stringify([
					{ pid: 300, ppid: 999, command: "codex.exe", commandLine: "codex.exe" },
					{
						pid: 301,
						ppid: 999,
						command: "C:\\Users\\d.cole\\AppData\\Local\\Programs\\claude.cmd",
						commandLine: "claude.cmd",
					},
					{ pid: 302, ppid: 999, command: "node.exe", commandLine: "C:\\tools\\unrelated.js" },
					{ pid: process.pid, ppid: 999, command: "codex.exe", commandLine: "codex.exe" },
					{ pid: 303, ppid: 999, command: "C:\\Users\\d.cole\\bin\\pi.bat", commandLine: "pi.bat" },
				]),
			}),
		});

		expect(pids).toEqual([300, 301, 303]);
	});

	it("finds orphaned Windows agent CLIs hosted by node or cmd shims", async () => {
		const pids = await findOrphanedAgentPids({
			platform: "win32",
			runPsCommand: async () => ({
				ok: true,
				stdout: JSON.stringify([
					{
						pid: 400,
						ppid: 999,
						command: "node.exe",
						commandLine:
							'node.exe "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"',
					},
					{
						pid: 401,
						ppid: 999,
						command: "cmd.exe",
						commandLine: 'C:\\Windows\\System32\\cmd.exe /d /s /c "claude --dangerously-skip-permissions"',
					},
					{
						pid: 402,
						ppid: 999,
						command: "node.exe",
						commandLine: 'node.exe "C:\\Users\\dev\\tools\\api-server.js"',
					},
				]),
			}),
		});

		expect(pids).toEqual([400, 401]);
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

	it("uses Windows process-tree termination for orphan cleanup", async () => {
		const killed: Array<{ pid: number; signal: string | number | undefined }> = [];

		await expect(
			killOrphanedAgentProcesses({
				platform: "win32",
				findPids: async () => [300],
				killProcessTree: (pid, signal, callback) => {
					killed.push({ pid, signal });
					callback?.();
				},
			}),
		).resolves.toBe(1);

		expect(killed).toEqual([{ pid: 300, signal: "SIGTERM" }]);
	});
});
