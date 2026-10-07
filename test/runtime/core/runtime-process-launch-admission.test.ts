import type * as NodePty from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertRuntimeProcessLaunchAdmission,
	installRuntimeProcessLaunchAdmission,
} from "../../../src/core/runtime-process-launch-admission.js";
import {
	resolveClaudeCliVersion,
	resolveClaudeExecutablePath,
} from "../../../src/execution/claude-structured-owner.js";
import { spawnCodexAppServerTransport } from "../../../src/execution/codex-app-server-client.js";
import { resolveCodexCliVersion } from "../../../src/execution/codex-structured-owner.js";
import { LanguageSession } from "../../../src/language-navigation/session.js";
import { spawnWindowsLanguageProcess } from "../../../src/language-navigation/windows-process-owner.js";
import { PtySession, _testing as ptyTesting } from "../../../src/terminal/pty-session.js";
import { _testing as titleTesting } from "../../../src/title/codex-client.js";
import { runGit } from "../../../src/workdir/git-utils.js";
import { runWorktreeSetupScript } from "../../../src/workdir/task-worktree-setup.js";

const child = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: child.spawn,
	execFile: child.execFile,
}));
vi.mock("../../../src/terminal/pty-runtime-health.js", async (original) => ({
	...(await original<typeof import("../../../src/terminal/pty-runtime-health.js")>()),
	preflightPtyLaunch: vi.fn(),
}));

let release: (() => void) | undefined;
const ptySpawn = vi.fn<typeof NodePty.spawn>();
beforeEach(() => {
	vi.clearAllMocks();
	ptyTesting.setNodePtySpawnOverride(ptySpawn);
});
afterEach(() => {
	release?.();
	release = undefined;
	ptyTesting.setNodePtySpawnOverride(null);
});

describe("runtime child launch admission", () => {
	it("preserves uninstalled factories and invokes synchronous custody admission on every launch", () => {
		expect(() => assertRuntimeProcessLaunchAdmission()).not.toThrow();
		const beforeSpawn = vi.fn();
		release = installRuntimeProcessLaunchAdmission({ beforeSpawn });
		assertRuntimeProcessLaunchAdmission();
		assertRuntimeProcessLaunchAdmission();
		expect(beforeSpawn).toHaveBeenCalledTimes(2);
		release();
		release();
		assertRuntimeProcessLaunchAdmission();
		expect(beforeSpawn).toHaveBeenCalledTimes(2);
	});

	it("refuses replacement and a stale disposer cannot uninstall a successor", () => {
		const old = installRuntimeProcessLaunchAdmission({ beforeSpawn: vi.fn() });
		expect(() => installRuntimeProcessLaunchAdmission({ beforeSpawn: vi.fn() })).toThrow("already installed");
		old();
		const next = vi.fn();
		release = installRuntimeProcessLaunchAdmission({ beforeSpawn: next });
		old();
		assertRuntimeProcessLaunchAdmission();
		expect(next).toHaveBeenCalledOnce();
	});

	it("does not bypass a newly lost lease after an earlier dirty-custody mark", () => {
		let current = true;
		const marks = vi.fn();
		release = installRuntimeProcessLaunchAdmission({
			beforeSpawn: () => {
				if (!current) throw new Error("Lease lost");
				marks();
			},
		});
		assertRuntimeProcessLaunchAdmission();
		current = false;
		expect(() => assertRuntimeProcessLaunchAdmission()).toThrow("Lease lost");
		expect(marks).toHaveBeenCalledOnce();
	});

	it("completes custody admission before spawning and keeps the released lease fenced", async () => {
		const order: string[] = [];
		let current = true;
		release = installRuntimeProcessLaunchAdmission({
			beforeSpawn: () => {
				order.push("assert-current");
				if (!current) throw new Error("Lease released");
				order.push("durable-custody-mark");
			},
		});
		child.execFile.mockImplementationOnce(
			(
				_binary: string,
				_args: string[],
				_options: unknown,
				callback: (error: Error | null, stdout: string, stderr: string) => void,
			) => {
				order.push("spawn");
				queueMicrotask(() => callback(null, "synthetic", ""));
				return { kill: vi.fn() };
			},
		);
		expect((await runGit("/synthetic", ["status"])).ok).toBe(true);
		expect(order).toEqual(["assert-current", "durable-custody-mark", "spawn"]);
		current = false;
		expect(await runGit("/synthetic", ["status"])).toMatchObject({ ok: false, error: "Lease released" });
		expect(child.execFile).toHaveBeenCalledOnce();
		expect(order.at(-1)).toBe("assert-current");
	});

	it("rejects asynchronous admission rather than launching before custody is durable", () => {
		release = installRuntimeProcessLaunchAdmission({ beforeSpawn: async () => undefined });
		expect(() => assertRuntimeProcessLaunchAdmission()).toThrow("synchronously");
	});

	const launches: Array<[string, () => unknown]> = [
		["native PTY", () => PtySession.spawn({ binary: process.execPath, cwd: process.cwd(), cols: 80, rows: 24 })],
		[
			"structured Codex transport",
			() => spawnCodexAppServerTransport({ binary: "synthetic-agent", args: [], cwd: "/synthetic", env: {} }),
		],
		["Claude executable probe", () => resolveClaudeCliVersion("synthetic-agent")],
		["Claude executable locator", () => resolveClaudeExecutablePath("synthetic-agent", {})],
		["Codex executable probe", () => resolveCodexCliVersion("synthetic-agent")],
		["title-generation executable", () => titleTesting.runCodexCommand([], 1000, "synthetic")],
		[
			"worktree setup shell",
			() =>
				runWorktreeSetupScript({
					worktreePath: "/synthetic",
					script: "echo synthetic",
					logPath: "/synthetic/output",
				}),
		],
		[
			"language server",
			() =>
				new LanguageSession({
					command: "synthetic-lsp",
					root: "/synthetic",
					config: {
						id: "synthetic",
						label: "Synthetic",
						enabled: true,
						command: "synthetic-lsp",
						args: [],
						extensions: [".ts"],
						rootMarkers: [],
					},
				}),
		],
		[
			"Windows language-server broker",
			() => spawnWindowsLanguageProcess("C:\\synthetic.exe", [], "C:\\synthetic", {}),
		],
	];
	it.each(launches)("refuses %s before creating any child", async (_label, launch) => {
		const refusal = new Error("Process custody persistence failed");
		release = installRuntimeProcessLaunchAdmission({
			beforeSpawn: () => {
				throw refusal;
			},
		});
		await expect(Promise.resolve().then(launch)).rejects.toBe(refusal);
		expect(child.spawn).not.toHaveBeenCalled();
		expect(child.execFile).not.toHaveBeenCalled();
		expect(ptySpawn).not.toHaveBeenCalled();
	});

	it("returns a typed Git command failure without starting Git when custody admission refuses", async () => {
		release = installRuntimeProcessLaunchAdmission({
			beforeSpawn: () => {
				throw new Error("Process custody persistence failed");
			},
		});
		expect(await runGit("/synthetic", ["status"])).toMatchObject({
			ok: false,
			exitCode: -1,
			error: "Process custody persistence failed",
		});
		expect(child.execFile).not.toHaveBeenCalled();
	});
});
