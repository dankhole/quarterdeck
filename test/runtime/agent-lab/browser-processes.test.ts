import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	_testing,
	findAgentLabBrowserProcessTree,
	mergeAgentLabBrowserProcessTrees,
	terminateAgentLabBrowserProcessTree,
} from "../../../scripts/agent-lab/browser-processes";

describe("Agent Lab browser process ownership", () => {
	it("selects every exact-session daemon and its descendants without matching another session or transcript", async () => {
		const repoRoot = "/repo/worktree";
		const daemonPath = join(repoRoot, "web-ui", "node_modules", "playwright-core", "lib", "entry", "cliDaemon.js");
		const result = await findAgentLabBrowserProcessTree(repoRoot, "qd-target-run", {
			platform: "darwin",
			resolveDaemonEntrypoint: () => daemonPath,
			runProcessList: async () => ({
				ok: true,
				stdout: [
					`101 1 /opt/node/bin/node ${daemonPath} qd-target-run --config=/tmp/one.json`,
					"102 101 /tmp/chrome --user-data-dir=/tmp/playwright-profile-one",
					"103 102 /tmp/chrome --type=renderer",
					`201 1 /opt/node/bin/node ${daemonPath} qd-other-run`,
					`301 1 /opt/node/bin/node ${daemonPath} qd-target-run`,
					"302 301 /tmp/chrome-headless-shell --headless",
					`999 1 /opt/node/bin/codex --prompt mentions ${daemonPath} qd-target-run`,
				].join("\n"),
			}),
		});

		expect(result).toEqual({
			rootPids: [101, 301],
			processPids: [101, 102, 103, 301, 302],
		});
	});

	it("resolves playwright-core from the installed CLI instead of assuming a nested dependency", () => {
		const resolveModule = vi
			.fn<(specifier: string, parentPath: string) => string>()
			.mockReturnValueOnce("/repo/web-ui/node_modules/@playwright/cli/package.json")
			.mockReturnValueOnce("/repo/web-ui/node_modules/playwright-core/package.json");

		expect(_testing.resolvePlaywrightDaemonEntrypoint("/repo", resolveModule)).toBe(
			"/repo/web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js",
		);
		expect(resolveModule).toHaveBeenNthCalledWith(1, "@playwright/cli/package.json", "/repo/web-ui/package.json");
		expect(resolveModule).toHaveBeenNthCalledWith(
			2,
			"playwright-core/package.json",
			"/repo/web-ui/node_modules/@playwright/cli/package.json",
		);
	});

	it("recognizes quoted Windows node and daemon paths", () => {
		const daemonPath = "C:\\Quarterdeck\\web-ui\\node_modules\\playwright-core\\lib\\entry\\cliDaemon.js";
		expect(
			_testing.isDaemonCommand(
				`"C:\\Program Files\\nodejs\\node.exe" "${daemonPath}" qd-windows-run --headed`,
				daemonPath,
				"qd-windows-run",
			),
		).toBe(true);
		expect(
			_testing.isDaemonCommand(
				`"C:\\Program Files\\nodejs\\node.exe" "${daemonPath}" qd-unrelated-run`,
				daemonPath,
				"qd-windows-run",
			),
		).toBe(false);
	});

	it("parses the Windows process snapshot used for scoped tree discovery", () => {
		expect(
			_testing.parseWindowsProcessList(
				JSON.stringify([
					{ pid: 41, ppid: 1, commandLine: "node.exe cliDaemon.js qd-target" },
					{ pid: 42, ppid: 41, commandLine: "chrome.exe --type=renderer" },
				]),
			),
		).toEqual([
			{ pid: 41, ppid: 1, commandLine: "node.exe cliDaemon.js qd-target" },
			{ pid: 42, ppid: 41, commandLine: "chrome.exe --type=renderer" },
		]);
	});

	it("rejects browser session names that cannot belong to Agent Lab", async () => {
		await expect(findAgentLabBrowserProcessTree("/repo", "default")).rejects.toThrow(
			"invalid Agent Lab browser session",
		);
	});

	it("merges pre-close and post-close ownership without losing replaced daemons", () => {
		expect(
			mergeAgentLabBrowserProcessTrees(
				{ rootPids: [10], processPids: [10, 11] },
				{ rootPids: [20, 10], processPids: [20, 21, 10] },
			),
		).toEqual({ rootPids: [10, 20], processPids: [10, 11, 20, 21] });
	});

	it("signals only the captured daemon tree and its process group", async () => {
		const alive = new Set([10, 11, 12]);
		const killProcessTree = vi.fn((pid: number, _signal: string | number | undefined, callback?: () => void) => {
			alive.delete(pid);
			alive.delete(11);
			callback?.();
		});
		const signalProcess = vi.fn((pid: number) => {
			if (pid === -10) alive.delete(12);
		});

		await expect(
			terminateAgentLabBrowserProcessTree(
				{ rootPids: [10], processPids: [10, 11, 12] },
				{
					platform: "darwin",
					killProcessTree,
					isAlive: (pid) => alive.has(pid),
					signalProcess,
					wait: async () => {},
				},
			),
		).resolves.toEqual([]);
		expect(killProcessTree).toHaveBeenCalledWith(10, "SIGTERM", expect.any(Function));
		expect(signalProcess).toHaveBeenCalledWith(-10, "SIGTERM");
	});
});
