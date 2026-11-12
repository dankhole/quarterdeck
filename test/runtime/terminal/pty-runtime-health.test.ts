import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifyPtySpawnFailure,
	formatSpawnFailure,
	inspectPtyRuntimeHealth,
	PtyLaunchCommandError,
	PtyLaunchCwdError,
	PtyRuntimeDependencyError,
	PtySpawnError,
	preflightPtyLaunch,
} from "../../../src/terminal";
import { assertPtyProcessLaunchBudget, PtyLaunchSizeError } from "../../../src/terminal/pty-runtime-health";

describe("PTY launch preflight", () => {
	let root: string;
	let cwd: string;
	let binDirectory: string;
	let binaryPath: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "quarterdeck-pty-preflight-"));
		cwd = join(root, "worktree");
		binDirectory = join(root, "bin");
		binaryPath = join(binDirectory, process.platform === "win32" ? "codex.cmd" : "codex");
		await mkdir(cwd, { recursive: true });
		await mkdir(binDirectory, { recursive: true });
		await writeFile(binaryPath, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\n", "utf8");
		if (process.platform !== "win32") await chmod(binaryPath, 0o755);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reports a missing launch cwd separately", () => {
		expect(() =>
			preflightPtyLaunch({
				binary: "codex",
				cwd: join(root, "missing-worktree"),
				env: { PATH: binDirectory },
			}),
		).toThrow(PtyLaunchCwdError);
	});

	it("reports a missing command separately", () => {
		expect(() =>
			preflightPtyLaunch({
				binary: "missing-agent",
				cwd,
				env: { PATH: binDirectory },
			}),
		).toThrow(PtyLaunchCommandError);
	});

	it("reports missing node-pty helper assets as a Quarterdeck runtime dependency failure", async () => {
		const packageRoot = join(root, "node-pty");
		const nativeDirectory = join(packageRoot, "prebuilds", "darwin-arm64");
		await mkdir(nativeDirectory, { recursive: true });
		await writeFile(join(nativeDirectory, "pty.node"), "native", "utf8");
		const health = inspectPtyRuntimeHealth({ packageRoot, platform: "darwin", arch: "arm64" });
		expect(health).toMatchObject({
			available: false,
			issue: "spawn_helper_missing",
			nativeModuleAvailable: true,
			spawnHelperAvailable: false,
		});

		const failure = classifyPtySpawnFailure(new Error("posix_spawn failed: No such file or directory"), {
			binary: "codex",
			cwd,
			env: { PATH: binDirectory },
			runtimeHealth: health,
		});
		expect(failure).toBeInstanceOf(PtyRuntimeDependencyError);
		expect(formatSpawnFailure("codex", failure, "task")).toContain("installed runtime dependency is missing");
		expect(formatSpawnFailure("codex", failure, "task")).toContain("npm ci --prefix web-ui");
		expect(formatSpawnFailure("codex", failure, "task")).toContain("restart Quarterdeck");
	});

	it("returns actionable typed size errors with no argument, environment or native cause content", () => {
		const secret = "private-content-never-include";
		for (const source of ["arguments", "environment"] as const) {
			let failure: unknown;
			try {
				assertPtyProcessLaunchBudget({
					binary: "agent",
					args: source === "arguments" ? [secret.repeat(60_000)] : [],
					env: source === "environment" ? { PRIVATE_TOKEN: secret.repeat(60_000) } : {},
					platform: "darwin",
				});
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(PtyLaunchSizeError);
			expect(failure).toMatchObject({ code: "launch_size_exceeded", source });
			const formatted = formatSpawnFailure("agent", failure, "task");
			expect(formatted).toContain(source === "arguments" ? "prompt/reference file" : "restart Quarterdeck");
			expect(formatted).not.toContain(secret);
			expect(JSON.stringify(failure)).not.toContain(secret);
			expect(JSON.stringify(failure)).not.toContain("PRIVATE_TOKEN");
		}
	});

	it.each([
		Object.assign(new Error("native message with private-argument-content"), { code: "E2BIG" }),
		new Error("posix_spawn failed: Argument list too long private-argument-content"),
	])("classifies real size failures below preflight budgets without leaking their cause", (original) => {
		const failure = classifyPtySpawnFailure(original, {
			binary: "codex",
			args: ["small"],
			cwd,
			env: { PATH: binDirectory },
		});
		expect(failure).toBeInstanceOf(PtyLaunchSizeError);
		expect(failure).toMatchObject({ source: "combined" });
		expect(failure.cause).toBeUndefined();
		expect(failure.message).toContain("prompt/reference file");
		expect(failure.message).toContain("Reduce exported environment variables");
		expect(failure.message).toContain("restart Quarterdeck");
		expect(failure.stack).not.toContain("private-argument-content");
	});

	it("keeps an existing typed launch error intact", () => {
		const failure = new PtyLaunchSizeError("arguments");
		expect(classifyPtySpawnFailure(failure, { binary: "codex", cwd, env: {} })).toBe(failure);
	});

	it("keeps unclassified spawn failures generic and preserves the underlying error", () => {
		const original = new Error("posix_spawn failed: operation not permitted");
		original.name = "NativeSpawnError";
		const failure = classifyPtySpawnFailure(original, {
			binary: "codex",
			cwd,
			env: { PATH: binDirectory },
		});
		expect(failure).toBeInstanceOf(PtySpawnError);
		expect(failure).not.toBeInstanceOf(PtyLaunchCommandError);
		expect(failure.cause).toBe(original);
		expect(formatSpawnFailure("codex", failure, "task")).toContain(
			"NativeSpawnError: posix_spawn failed: operation not permitted",
		);
	});
});
