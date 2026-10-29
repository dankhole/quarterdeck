import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	_testing,
	type AgentLabBrowserProcessTree,
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
				]
					.map((row) => row.replace(/^(\d+ \d+) /u, "$1 Thu Oct 22 16:31:06 2026 "))
					.join("\n"),
			}),
		});

		expect(result).toMatchObject({
			rootPids: [101, 301],
			processPids: [101, 102, 103, 301, 302],
		});
	});

	it("discovers a reparented nodeHost daemon without selecting another run, worktree, or transcript", async () => {
		const repoRoot = "/repo/abandoned-worktree";
		const daemonPath = join(repoRoot, "web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js");
		const nodeHost = "/Users/synthetic/Applications/Quarterdeck.app/Contents/Resources/runtime/bin/nodeHost";
		const result = await findAgentLabBrowserProcessTree(repoRoot, "qd-target-run", {
			platform: "darwin",
			resolveDaemonEntrypoint: () => daemonPath,
			runProcessList: async () => ({
				ok: true,
				stdout: [
					`80906 1 ${nodeHost} ${daemonPath} qd-target-run --config=/repo/run/playwright-cli.config.json`,
					"80907 80906 /shared/playwright-browsers/chrome-headless-shell --headless",
					`80908 1 ${nodeHost} ${daemonPath} qd-target-run-other`,
					`80909 1 ${nodeHost} /repo/other/web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js qd-target-run`,
					`80910 1 /bin/echo ${nodeHost} ${daemonPath} qd-target-run`,
				]
					.map((row) => row.replace(/^(\d+ \d+) /u, "$1 Thu Oct 22 16:31:06 2026 "))
					.join("\n"),
			}),
		});
		expect(result).toMatchObject({ rootPids: [80906], processPids: [80906, 80907] });
	});

	it.each(["node", "nodeHost"])("recognizes an unquoted Unix %s executable path with spaces", async (name) => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-node-path-test-"));
		try {
			const bin = join(root, "Node Tools", "bin");
			await mkdir(bin, { recursive: true });
			const executable = join(bin, name);
			await writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
			const daemonPath = "/repo/web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js";
			expect(
				_testing.isDaemonCommand(
					`${executable} ${daemonPath} qd-target-run`,
					daemonPath,
					"qd-target-run",
					"darwin",
				),
			).toBe(true);
			for (const prefix of [`/bin/echo ${executable}`, `node --eval ${executable}`, `/bin/sh -c ${executable}`]) {
				expect(
					_testing.isDaemonCommand(`${prefix} ${daemonPath} qd-target-run`, daemonPath, "qd-target-run", "darwin"),
				).toBe(false);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retains start and command identities for discovered roots and descendants", async () => {
		const daemonPath = "/repo/web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js";
		const result = await findAgentLabBrowserProcessTree("/repo", "qd-target-run", {
			platform: "darwin",
			resolveDaemonEntrypoint: () => daemonPath,
			runProcessList: async () => ({
				ok: true,
				stdout: `10 1 Thu Oct 22 16:31:06 2026 /bin/node ${daemonPath} qd-target-run\n11 10 Thu Oct 22 16:31:07 2026 /tmp/chrome`,
			}),
		});
		expect(result.identities).toEqual([
			{ pid: 10, startTime: "Thu Oct 22 16:31:06 2026", commandLine: `/bin/node ${daemonPath} qd-target-run` },
			{ pid: 11, startTime: "Thu Oct 22 16:31:07 2026", commandLine: "/tmp/chrome" },
		]);
	});

	it.each(["darwin", "win32"] as const)(
		"does not discover an older process through a stale %s parent PID",
		async (platform) => {
			const daemonPath = "/repo/web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js";
			const startTime = platform === "win32" ? "2026-10-22T16:31:06.1234567Z" : "Thu Oct 22 16:31:06 2026";
			const older = platform === "win32" ? "2026-10-22T16:31:06.1234566Z" : "Thu Oct 22 16:31:05 2026";
			const rows = [
				{ pid: 10, ppid: 1, startTime, commandLine: `/bin/node ${daemonPath} qd-target-run` },
				{ pid: 11, ppid: 10, startTime: older, commandLine: "Quarterdeck.exe" },
				{ pid: 12, ppid: 10, startTime, commandLine: "chrome-headless-shell" },
			];
			const result = await findAgentLabBrowserProcessTree("/repo", "qd-target-run", {
				platform,
				resolveDaemonEntrypoint: () => daemonPath,
				runProcessList: async () => ({
					ok: true,
					stdout:
						platform === "win32"
							? JSON.stringify(rows)
							: rows.map((row) => `${row.pid} ${row.ppid} ${row.startTime} ${row.commandLine}`).join("\n"),
				}),
			});
			expect(result.processPids).toEqual([10, 12]);
		},
	);

	it.each(["darwin", "win32"] as const)(
		"fails closed for a would-be %s child without start identity",
		async (platform) => {
			const daemonPath = "/repo/web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js";
			const rows = [
				{
					pid: 10,
					ppid: 1,
					startTime: platform === "win32" ? "2026-10-22T16:31:06.1234567Z" : "Thu Oct 22 16:31:06 2026",
					commandLine: `/bin/node ${daemonPath} qd-target-run`,
				},
				{ pid: 11, ppid: 10, startTime: null, commandLine: "chrome-headless-shell" },
			];
			await expect(
				findAgentLabBrowserProcessTree("/repo", "qd-target-run", {
					platform,
					resolveDaemonEntrypoint: () => daemonPath,
					runProcessList: async () => ({
						ok: true,
						stdout:
							platform === "win32"
								? JSON.stringify(rows)
								: rows
										.map((row) => `${row.pid} ${row.ppid} ${row.startTime ?? ""} ${row.commandLine}`)
										.join("\n"),
					}),
				}),
			).rejects.toThrow("PIDs: 11");
		},
	);

	it("registers a detached Chromium group during initial discovery and finds its orphan renderer", async () => {
		const daemonPath = "/repo/web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js";
		const result = await findAgentLabBrowserProcessTree("/repo", "qd-target-run", {
			platform: "darwin",
			resolveDaemonEntrypoint: () => daemonPath,
			runProcessList: async () => ({
				ok: true,
				stdout: [
					`10 1 10 Thu Oct 22 16:31:06 2026 /bin/node ${daemonPath} qd-target-run`,
					"11 10 11 Thu Oct 22 16:31:07 2026 /tmp/chrome-headless-shell",
					"12 1 11 Thu Oct 22 16:31:08 2026 /tmp/chrome --type=renderer",
					"20 1 20 Thu Oct 22 16:31:08 2026 /tmp/unrelated-chrome",
				].join("\n"),
			}),
		});
		expect(result.processPids).toEqual([10, 11, 12]);
		expect(result.groups?.map(({ pid }) => pid)).toEqual([10, 11]);
	});

	it("uses a retained group to find an orphan but rejects contradictory child birth order", async () => {
		const daemonPath = "/repo/web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js";
		const group = {
			pid: 10,
			pgid: 10,
			startTime: "Thu Oct 22 16:31:06 2026",
			commandLine: `/bin/node ${daemonPath} qd-target-run`,
		};
		const result = await findAgentLabBrowserProcessTree("/repo", "qd-target-run", {
			platform: "darwin",
			groups: [group],
			resolveDaemonEntrypoint: () => daemonPath,
			runProcessList: async () => ({
				ok: true,
				stdout: [
					"12 11 10 Thu Oct 22 16:31:07 2026 /tmp/older-helper",
					"11 1 10 Thu Oct 22 16:31:08 2026 /tmp/chrome",
					"13 1 10 Thu Oct 22 16:31:07 2026 /tmp/orphan-helper",
					"20 1 20 Thu Oct 22 16:31:08 2026 /tmp/unrelated-helper",
				].join("\n"),
			}),
		});
		expect(result.rootPids).toEqual([]);
		expect(result.processPids).toEqual([11, 13]);
		expect(result.groups).toEqual([group]);
	});

	it("changes only the date locale while preserving inherited character rendering", () => {
		expect(_testing.processListEnvironment({ LANG: "en_US.UTF-8", LC_CTYPE: "UTF-8" })).toEqual({
			LANG: "en_US.UTF-8",
			LC_CTYPE: "UTF-8",
			LC_TIME: "C",
			TZ: "UTC",
		});
		expect(_testing.processListEnvironment({ LANG: "en_US.UTF-8", LC_ALL: "en_GB.UTF-8" })).toEqual({
			LANG: "en_US.UTF-8",
			LC_CTYPE: "en_GB.UTF-8",
			LC_TIME: "C",
			TZ: "UTC",
		});
	});

	it.skipIf(process.platform === "win32")(
		"discovers a synthetic Unicode-path Node child through real ps output",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-café-process-test-"));
			const daemonPath = join(root, "web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js");
			await mkdir(join(root, "web-ui/node_modules/playwright-core/lib/entry"), { recursive: true });
			await writeFile(daemonPath, "setTimeout(() => {}, 10000);\n");
			const locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
			vi.stubEnv("LC_ALL", undefined);
			vi.stubEnv("LANG", locale);
			vi.stubEnv("LC_CTYPE", locale);
			const child = spawn(process.execPath, [daemonPath, "qd-unicode-fixture"], { stdio: "ignore" });
			const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
			try {
				await once(child, "spawn");
				const result = await findAgentLabBrowserProcessTree(root, "qd-unicode-fixture");
				expect(result.rootPids).toEqual([child.pid]);
				expect(result.identities?.[0]?.commandLine).toContain("café");
			} finally {
				child.kill("SIGKILL");
				await exited;
				vi.unstubAllEnvs();
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("can recover the worktree-local daemon path after dependencies have been removed", () => {
		expect(
			_testing.resolvePlaywrightDaemonEntrypoint("/repo/abandoned-worktree", () => {
				throw new Error("MODULE_NOT_FOUND");
			}),
		).toBe(join("/repo/abandoned-worktree", "web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js"));
	});

	it("resolves playwright-core from the installed CLI instead of assuming a nested dependency", () => {
		const cliPackagePath = join("/repo", "web-ui", "node_modules", "@playwright", "cli", "package.json");
		const corePackagePath = join("/repo", "web-ui", "node_modules", "playwright-core", "package.json");
		const resolveModule = vi
			.fn<(specifier: string, parentPath: string) => string>()
			.mockReturnValueOnce(cliPackagePath)
			.mockReturnValueOnce(corePackagePath);

		expect(_testing.resolvePlaywrightDaemonEntrypoint("/repo", resolveModule)).toBe(
			join("/repo", "web-ui", "node_modules", "playwright-core", "lib", "entry", "cliDaemon.js"),
		);
		expect(resolveModule).toHaveBeenNthCalledWith(
			1,
			"@playwright/cli/package.json",
			join("/repo", "web-ui", "package.json"),
		);
		expect(resolveModule).toHaveBeenNthCalledWith(2, "playwright-core/package.json", cliPackagePath);
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

	it("matches Windows daemon paths case-insensitively", () => {
		const daemonPath = "C:\\Quarterdeck\\web-ui\\node_modules\\playwright-core\\lib\\entry\\cliDaemon.js";

		expect(
			_testing.isDaemonCommand(
				`"C:\\Program Files\\nodejs\\node.exe" "c:\\quarterdeck\\WEB-UI\\node_modules\\playwright-core\\lib\\entry\\CLIDAEMON.JS" qd-windows-run`,
				daemonPath,
				"qd-windows-run",
				"win32",
			),
		).toBe(true);
	});

	it("parses the Windows process snapshot used for scoped tree discovery", () => {
		expect(
			_testing.parseWindowsProcessList(
				JSON.stringify([
					{
						pid: 41,
						ppid: 1,
						startTime: "2026-10-22T16:31:06.1234567Z",
						commandLine: "node.exe cliDaemon.js qd-target",
					},
					{
						pid: 42,
						ppid: 41,
						startTime: "2026-10-22T16:31:07.1234567Z",
						commandLine: "chrome.exe --type=renderer",
					},
				]),
			),
		).toEqual([
			{
				pid: 41,
				ppid: 1,
				startTime: "2026-10-22T16:31:06.1234567Z",
				commandLine: "node.exe cliDaemon.js qd-target",
			},
			{ pid: 42, ppid: 41, startTime: "2026-10-22T16:31:07.1234567Z", commandLine: "chrome.exe --type=renderer" },
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
		).toEqual({ rootPids: [10, 20], processPids: [10, 11, 20, 21], identities: [] });
	});
});

function terminationFixture() {
	const startTime = "Thu Oct 22 16:31:06 2026";
	const records = new Map<number, { ppid: number; pgid?: number; startTime: string; commandLine: string }>([
		[10, { ppid: 1, startTime, commandLine: "/bin/node cliDaemon.js qd-target-run" }],
		[11, { ppid: 10, startTime, commandLine: "/tmp/chrome-headless-shell --headless" }],
		[20, { ppid: 1, startTime, commandLine: "/tmp/unrelated-browser" }],
	]);
	const tree: AgentLabBrowserProcessTree = {
		rootPids: [10],
		processPids: [10, 11],
		identities: [...records]
			.filter(([pid]) => pid !== 20)
			.map(([pid, row]) => ({ pid, startTime: row.startTime, commandLine: row.commandLine })),
	};
	const runProcessList = vi.fn(async () => ({
		ok: true,
		stdout: [...records]
			.map(
				([pid, row]) =>
					`${pid} ${row.ppid} ${row.pgid === undefined ? "" : `${row.pgid} `}${row.startTime} ${row.commandLine}`,
			)
			.join("\n"),
	}));
	const wait = async (milliseconds: number) => {
		vi.advanceTimersByTime(milliseconds);
	};
	return { records, tree, runProcessList, wait };
}

function groupedTerminationFixture() {
	const fixture = terminationFixture();
	for (const [pid, row] of fixture.records) row.pgid = pid === 20 ? 20 : 10;
	fixture.tree.identities = [...fixture.records]
		.filter(([pid]) => pid !== 20)
		.map(([pid, { pgid, startTime, commandLine }]) => ({ pid, pgid, startTime, commandLine }));
	fixture.tree.groups = fixture.tree.identities.filter(({ pid }) => pid === 10);
	return fixture;
}

describe("Agent Lab identity-checked browser termination", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("never escalates an exited root or its old group when a browser child survives", async () => {
		const fixture = terminationFixture();
		const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
			if (pid === 10 || signal === "SIGKILL") fixture.records.delete(pid);
		});
		await expect(
			terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform: "darwin", signalProcess }),
		).resolves.toEqual([]);
		expect(signalProcess.mock.calls).toEqual([
			[10, "SIGTERM"],
			[11, "SIGTERM"],
			[11, "SIGKILL"],
		]);
		expect(fixture.records.has(20)).toBe(true);
	});

	it("refuses a root PID reused with the same command but a different start time", async () => {
		const fixture = terminationFixture();
		const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
			if (pid === 10) {
				fixture.records.set(10, {
					ppid: 1,
					startTime: "Thu Oct 22 16:31:09 2026",
					commandLine: "/bin/node cliDaemon.js qd-target-run",
				});
			} else if (signal === "SIGKILL") fixture.records.delete(pid);
		});
		await expect(
			terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform: "darwin", signalProcess }),
		).rejects.toThrow("ambiguous Agent Lab browser process identities for PIDs: 10");
		expect(signalProcess.mock.calls).toEqual([
			[10, "SIGTERM"],
			[11, "SIGTERM"],
			[11, "SIGKILL"],
		]);
		expect(fixture.records.get(10)?.startTime).toBe("Thu Oct 22 16:31:09 2026");
	});

	it("rechecks each target immediately before escalation, not just once per pass", async () => {
		const fixture = terminationFixture();
		const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
			if (signal !== "SIGKILL") return;
			fixture.records.delete(pid);
			// The child is killed first. Its root PID is reused before the next signal.
			fixture.records.set(10, {
				ppid: 1,
				startTime: "Thu Oct 22 16:31:10 2026",
				commandLine: "/tmp/unrelated-node",
			});
		});
		await expect(
			terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform: "darwin", signalProcess }),
		).rejects.toThrow("PIDs: 10");
		expect(signalProcess).not.toHaveBeenCalledWith(10, "SIGKILL");
		expect(signalProcess.mock.calls.every(([pid]) => pid > 0)).toBe(true);
	});

	it("refuses a captured descendant whose command identity changed", async () => {
		const fixture = terminationFixture();
		const child = fixture.records.get(11);
		if (!child) throw new Error("Missing fixture child");
		fixture.records.set(11, { ...child, commandLine: "/tmp/unrelated-process" });
		const signalProcess = vi.fn((pid: number, _signal: NodeJS.Signals) => {
			fixture.records.delete(pid);
		});
		await expect(
			terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform: "darwin", signalProcess }),
		).rejects.toThrow("PIDs: 11");
		expect(signalProcess.mock.calls).toEqual([[10, "SIGTERM"]]);
	});

	it("captures late descendants only through a still identity-matching browser parent", async () => {
		const fixture = terminationFixture();
		const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
			if (pid === 10 || signal === "SIGKILL") fixture.records.delete(pid);
			if (pid === 11 && signal === "SIGTERM") {
				fixture.records.set(12, {
					ppid: 11,
					startTime: "Thu Oct 22 16:31:07 2026",
					commandLine: "/tmp/chrome --type=renderer",
				});
			}
		});
		await expect(
			terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform: "darwin", signalProcess }),
		).resolves.toEqual([]);
		expect(signalProcess).toHaveBeenCalledWith(12, "SIGKILL");
		expect(fixture.records.has(20)).toBe(true);
	});

	it.each(["darwin", "win32"] as const)(
		"does not adopt an older late child through a stale %s parent PID",
		async (platform) => {
			const fixture = terminationFixture();
			const startTime = platform === "win32" ? "2026-10-22T16:31:06.1234567Z" : "Thu Oct 22 16:31:06 2026";
			for (const row of fixture.records.values()) row.startTime = startTime;
			fixture.tree.identities = fixture.tree.identities?.map((identity) => ({ ...identity, startTime }));
			const signalProcess = vi.fn((pid: number) => {
				fixture.records.set(12, {
					ppid: 11,
					startTime: platform === "win32" ? "2026-10-22T16:31:06.1234566Z" : "Thu Oct 22 16:31:05 2026",
					commandLine: "Quarterdeck.exe",
				});
				fixture.records.delete(pid);
			});
			const runProcessList =
				platform === "win32"
					? async () => ({
							ok: true,
							stdout: JSON.stringify([...fixture.records].map(([pid, row]) => ({ pid, ...row }))),
						})
					: fixture.runProcessList;
			await expect(
				terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform, runProcessList, signalProcess }),
			).resolves.toEqual([]);
			expect(signalProcess).not.toHaveBeenCalledWith(12, expect.anything());
			expect(fixture.records.has(12)).toBe(true);
		},
	);

	it("finds a newly spawned helper by the verified daemon group after its parent exits", async () => {
		const fixture = groupedTerminationFixture();
		const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
			if (pid === 11 && signal === "SIGTERM") {
				fixture.records.set(12, {
					ppid: 1,
					pgid: 10,
					startTime: "Thu Oct 22 16:31:07 2026",
					commandLine: "/tmp/chrome-helper",
				});
			}
			fixture.records.delete(pid);
		});
		await expect(
			terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform: "darwin", signalProcess }),
		).resolves.toEqual([]);
		expect(signalProcess).toHaveBeenCalledWith(12, "SIGKILL");
		expect(signalProcess.mock.calls.every(([pid]) => pid > 0)).toBe(true);
		expect(fixture.records.has(20)).toBe(true);
	});

	it("finds a helper spawned during the final parent SIGKILL and cleans it on the next pass", async () => {
		const fixture = groupedTerminationFixture();
		const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
			if (pid === 10) fixture.records.delete(pid);
			if (signal === "SIGKILL") {
				if (pid === 11)
					fixture.records.set(12, {
						ppid: 1,
						pgid: 10,
						startTime: "Thu Oct 22 16:31:07 2026",
						commandLine: "/tmp/last-helper",
					});
				fixture.records.delete(pid);
			}
		});
		await expect(
			terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform: "darwin", signalProcess }),
		).resolves.toEqual([]);
		expect(signalProcess).toHaveBeenCalledWith(12, "SIGKILL");
		expect(fixture.records.has(20)).toBe(true);
	});

	it.each(["captured", "newly-discovered"] as const)(
		"tracks a %s detached Chromium group after its leader exits",
		async (kind) => {
			const fixture = groupedTerminationFixture();
			const browser = fixture.records.get(11);
			if (!browser) throw new Error("Missing fixture browser");
			browser.pgid = 11;
			browser.startTime = "Thu Oct 22 16:31:07 2026";
			fixture.tree.identities = fixture.tree.identities?.map((identity) =>
				identity.pid === 11 ? { ...identity, pgid: 11, startTime: browser.startTime } : identity,
			);
			if (kind === "newly-discovered") {
				fixture.tree.processPids = [10];
				fixture.tree.identities = fixture.tree.identities?.filter(({ pid }) => pid === 10);
			}
			const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
				if (pid === 11 && signal === "SIGKILL") {
					fixture.records.set(12, {
						ppid: 1,
						pgid: 11,
						startTime: "Thu Oct 22 16:31:08 2026",
						commandLine: "/tmp/chrome --type=renderer",
					});
				}
				if (pid === 10 || signal === "SIGKILL") fixture.records.delete(pid);
			});
			await expect(
				terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform: "darwin", signalProcess }),
			).resolves.toEqual([]);
			expect(signalProcess).toHaveBeenCalledWith(12, "SIGKILL");
			expect(signalProcess.mock.calls.every(([pid]) => pid > 0)).toBe(true);
			expect(fixture.records.has(20)).toBe(true);
		},
	);

	it("does not adopt helpers from a reused group leader", async () => {
		const fixture = groupedTerminationFixture();
		const signalProcess = vi.fn((pid: number) => {
			fixture.records.delete(pid);
			if (pid === 10) {
				fixture.records.set(10, {
					ppid: 1,
					pgid: 10,
					startTime: "Thu Oct 22 16:31:08 2026",
					commandLine: "/tmp/unrelated-node",
				});
				fixture.records.set(12, {
					ppid: 1,
					pgid: 10,
					startTime: "Thu Oct 22 16:31:09 2026",
					commandLine: "/tmp/unrelated-helper",
				});
			}
		});
		await expect(
			terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform: "darwin", signalProcess }),
		).rejects.toThrow("PIDs: 10");
		expect(signalProcess).not.toHaveBeenCalledWith(12, expect.anything());
		expect(signalProcess).not.toHaveBeenCalledWith(10, "SIGKILL");
	});

	it("refuses a would-be orphan group member whose start identity is missing", async () => {
		const fixture = groupedTerminationFixture();
		fixture.records.set(12, { ppid: 1, pgid: 10, startTime: "unknown", commandLine: "/tmp/chrome-helper" });
		const signalProcess = vi.fn((pid: number) => {
			fixture.records.delete(pid);
		});
		await expect(
			terminateAgentLabBrowserProcessTree(fixture.tree, { ...fixture, platform: "darwin", signalProcess }),
		).rejects.toThrow("PIDs: 12");
		expect(signalProcess).not.toHaveBeenCalledWith(12, expect.anything());
	});

	it("uses Windows creation identity for the same per-PID termination boundary", async () => {
		const fixture = terminationFixture();
		const startTime = "2026-10-22T16:31:06.1234567Z";
		for (const row of fixture.records.values()) row.startTime = startTime;
		fixture.tree.identities = fixture.tree.identities?.map((identity) => ({ ...identity, startTime }));
		const signalProcess = vi.fn((pid: number) => {
			fixture.records.delete(pid);
		});
		const runProcessList = async () => ({
			ok: true,
			stdout: JSON.stringify([...fixture.records].map(([pid, row]) => ({ pid, ...row }))),
		});
		await expect(
			terminateAgentLabBrowserProcessTree(fixture.tree, {
				...fixture,
				runProcessList,
				platform: "win32",
				signalProcess,
			}),
		).resolves.toEqual([]);
		expect(signalProcess.mock.calls).toEqual([
			[10, "SIGTERM"],
			[11, "SIGTERM"],
		]);
	});

	it("refuses missing start identity rather than signalling a bare PID", async () => {
		const fixture = terminationFixture();
		const signalProcess = vi.fn();
		await expect(
			terminateAgentLabBrowserProcessTree(
				{ ...fixture.tree, identities: [] },
				{ ...fixture, platform: "darwin", signalProcess },
			),
		).rejects.toThrow("ambiguous");
		expect(signalProcess).not.toHaveBeenCalled();
	});

	it("preserves conflicting pre/post-close identities so a reused PID is not adopted", async () => {
		const fixture = terminationFixture();
		const reused = {
			pid: 10,
			startTime: "Thu Oct 22 16:31:10 2026",
			commandLine: "/bin/node cliDaemon.js qd-target-run",
		};
		const tree = mergeAgentLabBrowserProcessTrees(fixture.tree, {
			rootPids: [10],
			processPids: [10],
			identities: [reused],
		});
		const signalProcess = vi.fn((pid: number, _signal: NodeJS.Signals) => {
			fixture.records.delete(pid);
		});
		await expect(
			terminateAgentLabBrowserProcessTree(tree, { ...fixture, platform: "darwin", signalProcess }),
		).rejects.toThrow("PIDs: 10");
		expect(signalProcess).not.toHaveBeenCalledWith(10, expect.anything());
	});
});
