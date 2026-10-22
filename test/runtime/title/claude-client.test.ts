import type { ChildProcess, ExecFileException } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetLoggerForTests, type RuntimeDiagnosticLogSink, setRuntimeDiagnosticLogSink } from "../../../src/core";
import { createTempDir } from "../../utilities/temp-dir";

const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: childProcessMocks.execFile,
	};
});

import { _testing, callClaude } from "../../../src/title/claude-client";

const OPTIONS = {
	systemPrompt: "Return only a concise title.",
	userPrompt: "make title generation reliable",
	timeoutMs: 20_000,
	model: "haiku",
};

function jsonResult(result: string, isError = false): string {
	return JSON.stringify({
		type: "result",
		subtype: isError ? "error_during_execution" : "success",
		is_error: isError,
		result,
	});
}

const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
let cleanupWindowsClaude = (): void => undefined;

beforeEach(() => {
	_testing.resetClaudeFailureBackoffForTests();
	if (process.platform !== "win32") return;
	const temp = createTempDir("quarterdeck-title-claude-");
	writeFileSync(join(temp.path, "claude.exe"), "", "utf8");
	process.env.PATH = [temp.path, originalPath].filter(Boolean).join(delimiter);
	process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.PS1";
	cleanupWindowsClaude = temp.cleanup;
});

type ExecCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

function requireExecCallback(callback: ExecCallback | null): ExecCallback {
	if (!callback) {
		throw new Error("Expected execFile callback to be captured");
	}
	return callback;
}

function createExecutor(
	result: Partial<{
		stdout: string;
		stderr: string;
		stdoutBytes: number;
		stderrBytes: number;
		exitStatus: number | null;
		signal: NodeJS.Signals | null;
		timedOut: boolean;
		errorClass: string | null;
	}> = {},
) {
	return {
		isAvailable: vi.fn(() => true),
		run: vi.fn(async (_args: string[], _timeoutMs: number, _input: string) => ({
			stdout: jsonResult("Reliable Task Titles"),
			stderr: "",
			stdoutBytes: 60,
			stderrBytes: 0,
			exitStatus: 0,
			signal: null,
			timedOut: false,
			errorClass: null,
			...result,
		})),
	};
}

type LogCandidate = Parameters<RuntimeDiagnosticLogSink["recordLog"]>[0];

function collectRuntimeLogs(): LogCandidate[] {
	const logs: LogCandidate[] = [];
	setRuntimeDiagnosticLogSink({
		recordLog: (candidate) => {
			logs.push(candidate);
		},
	});
	return logs;
}

afterEach(() => {
	vi.useRealTimers();
	childProcessMocks.execFile.mockReset();
	_resetLoggerForTests();
	_testing.resetClaudeFailureBackoffForTests();
	cleanupWindowsClaude();
	cleanupWindowsClaude = (): void => undefined;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (originalPathExt === undefined) delete process.env.PATHEXT;
	else process.env.PATHEXT = originalPathExt;
	delete process.env.QUARTERDECK_HOOK_TASK_ID;
	delete process.env.QUARTERDECK_HOOK_PROJECT_ID;
	delete process.env.QUARTERDECK_HOOK_SESSION_INSTANCE_ID;
	delete process.env.QUARTERDECK_SOME_FUTURE_VAR;
	delete process.env.CLAUDECODE;
	delete process.env.CLAUDE_CODE_ENTRYPOINT;
	delete process.env.CLAUDE_CODE_SSE_PORT;
	delete process.env.CLAUDE_CODE_SESSION_ID;
	delete process.env.CLAUDE_CODE_CHILD_SESSION;
	delete process.env.CLAUDE_CODE_SESSION_ATTENDED;
	delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
	delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
	delete process.env.CLAUDE_PID;
	delete process.env.CLAUDE_EFFORT;
	delete process.env.CLAUDE_CODE_EXECPATH;
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.CLAUDE_CONFIG_DIR;
	delete process.env.CLAUDE_CODE_USE_BEDROCK;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe("callClaude", () => {
	it("returns the sanitized final Claude result", async () => {
		const executor = createExecutor({ stdout: jsonResult("Title: Reliable Task Titles") });

		expect(await callClaude(OPTIONS, executor)).toBe("Reliable Task Titles");
		expect(executor.run).toHaveBeenCalledWith(expect.any(Array), 20_000, expect.any(String));
	});

	it("uses an isolated, tool-disabled, non-persistent invocation", async () => {
		const executor = createExecutor();

		await callClaude(OPTIONS, executor);

		const args = executor.run.mock.calls[0]?.[0] ?? [];
		expect(args).toEqual(
			expect.arrayContaining([
				"-p",
				"--output-format",
				"json",
				"--no-session-persistence",
				"--safe-mode",
				"--strict-mcp-config",
				"--tools=",
			]),
		);
		// --bare forces API-key-only auth and would break a normal OAuth/keychain login; never used.
		expect(args).not.toContain("--bare");
		// user-level settings.json (where an apiKeyHelper or other auth config commonly lives)
		// still loads; project/local settings.json do not.
		const settingSourcesIndex = args.indexOf("--setting-sources");
		expect(settingSourcesIndex).toBeGreaterThanOrEqual(0);
		expect(args[settingSourcesIndex + 1]).toBe("user");
		const modelIndex = args.indexOf("--model");
		expect(args[modelIndex + 1]).toBe("haiku");
		// --system-prompt is fixed and single-line (Windows .cmd shims can break on embedded
		// newlines); the caller's real, possibly multi-line, role instructions travel over
		// stdin instead.
		const systemPromptIndex = args.indexOf("--system-prompt");
		const systemPromptValue = args[systemPromptIndex + 1];
		expect(systemPromptValue).not.toContain("\n");
		expect(systemPromptValue).not.toContain("Return only a concise title");
		const stdinPayload = executor.run.mock.calls[0]?.[2] ?? "";
		expect(stdinPayload).toContain("Return only a concise title");
		expect(stdinPayload).toContain("<input-context>\nmake title generation reliable\n</input-context>");
	});

	it("does not spawn when Claude is unavailable", async () => {
		const executor = createExecutor();
		executor.isAvailable.mockReturnValue(false);

		expect(await callClaude(OPTIONS, executor)).toBeNull();
		expect(executor.run).not.toHaveBeenCalled();
	});

	it("returns null when the Claude process fails", async () => {
		const logs = collectRuntimeLogs();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const executor = createExecutor({
			stdout: "private generated title",
			stderr: "private task context",
			stdoutBytes: 23,
			stderrBytes: 20,
			exitStatus: 1,
			errorClass: "ExecFileError",
		});

		expect(await callClaude(OPTIONS, executor)).toBeNull();
		const failure = logs.find(
			(entry) => entry.tag === "claude-helper" && entry.message === "Claude helper call failed",
		);
		expect(failure?.data).toMatchObject({
			errorClass: "ExecFileError",
			stdoutBytes: 23,
			stderrBytes: 20,
		});
		expect(JSON.stringify(failure?.data)).not.toContain("private");
	});

	it("returns null when the result JSON reports is_error", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const executor = createExecutor({ stdout: jsonResult("refused", true) });

		expect(await callClaude(OPTIONS, executor)).toBeNull();
	});

	it("returns null when the subtype is not success even if is_error is false", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const executor = createExecutor({
			stdout: JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false, result: "partial" }),
		});

		expect(await callClaude(OPTIONS, executor)).toBeNull();
	});

	it("returns null when stdout is not the expected JSON result shape", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const executor = createExecutor({ stdout: "not json" });

		expect(await callClaude(OPTIONS, executor)).toBeNull();
	});

	it("backs off further calls for a bounded period after an auth-classified failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const failingExecutor = createExecutor({
			stdout: "",
			stderr: "Invalid API key · Please run /login",
			exitStatus: 1,
		});

		expect(await callClaude(OPTIONS, failingExecutor)).toBeNull();
		expect(failingExecutor.run).toHaveBeenCalledTimes(1);

		const secondExecutor = createExecutor();
		expect(await callClaude(OPTIONS, secondExecutor)).toBeNull();
		expect(secondExecutor.run).not.toHaveBeenCalled();
	});

	it("backs off further calls after an unsupported-flag failure on an older Claude CLI", async () => {
		const logs = collectRuntimeLogs();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const failingExecutor = createExecutor({
			stdout: "",
			stderr: "error: unknown option '--safe-mode'",
			exitStatus: 1,
		});

		expect(await callClaude(OPTIONS, failingExecutor)).toBeNull();
		const diagnostic = logs.find(
			(entry) =>
				entry.tag === "claude-helper" &&
				entry.message === "Unsupported Claude CLI flag detected; backing off helper calls",
		);
		expect(diagnostic).toBeDefined();

		const secondExecutor = createExecutor();
		expect(await callClaude(OPTIONS, secondExecutor)).toBeNull();
		expect(secondExecutor.run).not.toHaveBeenCalled();
	});

	it("does not classify a loose mention of 'unknown option' as commander's exact rejection form", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const failingExecutor = createExecutor({
			stdout: "",
			stderr: "the tool received an unknown option today and ignored it",
			exitStatus: 1,
		});

		expect(await callClaude(OPTIONS, failingExecutor)).toBeNull();

		const secondExecutor = createExecutor();
		expect(await callClaude(OPTIONS, secondExecutor)).toBe("Reliable Task Titles");
		expect(secondExecutor.run).toHaveBeenCalledTimes(1);
	});

	it("does not back off after a non-auth failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const failingExecutor = createExecutor({ stdout: "", stderr: "network unreachable", exitStatus: 1 });

		expect(await callClaude(OPTIONS, failingExecutor)).toBeNull();

		const secondExecutor = createExecutor();
		expect(await callClaude(OPTIONS, secondExecutor)).toBe("Reliable Task Titles");
		expect(secondExecutor.run).toHaveBeenCalledTimes(1);
	});

	it("backs off further calls for a short period after a timeout, distinct from the non-retryable backoff", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(_testing.CLAUDE_TIMEOUT_BACKOFF_MS).toBeLessThan(_testing.CLAUDE_FAILURE_BACKOFF_MS);
		const timedOutExecutor = createExecutor({ stdout: "", stderr: "", exitStatus: null, timedOut: true });

		expect(await callClaude(OPTIONS, timedOutExecutor)).toBeNull();

		const secondExecutor = createExecutor();
		expect(await callClaude(OPTIONS, secondExecutor)).toBeNull();
		expect(secondExecutor.run).not.toHaveBeenCalled();
	});

	it("does not log Claude's generated text for a result-level error", async () => {
		const logs = collectRuntimeLogs();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const executor = createExecutor({ stdout: jsonResult("super secret generated text", true) });

		expect(await callClaude(OPTIONS, executor)).toBeNull();
		const failure = logs.find(
			(entry) =>
				entry.tag === "claude-helper" && entry.message === "Claude helper call reported a result-level error",
		);
		expect(failure?.data).toMatchObject({ resultLength: "super secret generated text".length });
		expect(JSON.stringify(failure?.data)).not.toContain("super secret");
	});

	it("does not log Claude's generated text when the sanitizer rejects it", async () => {
		const logs = collectRuntimeLogs();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const executor = createExecutor({ stdout: jsonResult("What is the title you want?") });

		expect(await callClaude(OPTIONS, executor)).toBeNull();
		const failure = logs.find(
			(entry) =>
				entry.tag === "claude-helper" &&
				entry.message === "Claude helper response was empty or rejected by sanitizer",
		);
		expect(failure?.data).toMatchObject({ resultLength: "What is the title you want?".length });
		expect(JSON.stringify(failure?.data)).not.toContain("What is the title");
	});

	it("sends large and option-like contexts through stdin instead of argv", async () => {
		const executor = createExecutor();
		const userPrompt = `- investigate failures\n${"diff content".repeat(4000)}`;
		await callClaude({ ...OPTIONS, userPrompt }, executor);
		const args = executor.run.mock.calls[0][0];

		expect(args.join(" ")).not.toContain(userPrompt);
		expect(executor.run.mock.calls[0][2]).toContain(userPrompt);
	});

	it("strips Quarterdeck and Claude Code session env vars before spawning, keeping auth/provider vars", async () => {
		process.env.QUARTERDECK_HOOK_TASK_ID = "leaked-task";
		process.env.QUARTERDECK_HOOK_PROJECT_ID = "leaked-project";
		process.env.QUARTERDECK_HOOK_SESSION_INSTANCE_ID = "leaked-session";
		process.env.QUARTERDECK_SOME_FUTURE_VAR = "leaked-future";
		process.env.CLAUDECODE = "1";
		process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
		process.env.CLAUDE_CODE_SSE_PORT = "12345";
		process.env.CLAUDE_CODE_SESSION_ID = "session-123";
		process.env.CLAUDE_CODE_CHILD_SESSION = "1";
		process.env.CLAUDE_CODE_SESSION_ATTENDED = "1";
		process.env.CLAUDE_CODE_MESSAGING_SOCKET = "/tmp/socket";
		process.env.CLAUDE_CODE_MESSAGING_TOKEN = "secret-token";
		process.env.CLAUDE_PID = "4242";
		process.env.CLAUDE_EFFORT = "high";
		process.env.CLAUDE_CODE_EXECPATH = "/usr/local/bin/claude";
		process.env.ANTHROPIC_API_KEY = "kept-api-key";
		process.env.CLAUDE_CONFIG_DIR = "/kept/config/dir";
		process.env.CLAUDE_CODE_USE_BEDROCK = "1";
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "kept-oauth-token";
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		let callback: ExecCallback | null = null;
		let capturedEnv: NodeJS.ProcessEnv | undefined;
		childProcessMocks.execFile.mockImplementation((...args: unknown[]) => {
			const candidate = args.at(-1);
			if (typeof candidate !== "function") {
				throw new Error("Expected execFile callback");
			}
			capturedEnv = (args[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
			callback = candidate as typeof callback;
			return { stdin, stdout, stderr } as unknown as ChildProcess;
		});

		const resultPromise = _testing.runClaudeCommand(["-p"], 20_000, "title context");
		requireExecCallback(callback)(null, jsonResult("Reliable Task Titles"), "");
		await resultPromise;

		expect(capturedEnv).toBeDefined();
		expect(capturedEnv?.QUARTERDECK_HOOK_TASK_ID).toBeUndefined();
		expect(capturedEnv?.QUARTERDECK_HOOK_PROJECT_ID).toBeUndefined();
		expect(capturedEnv?.QUARTERDECK_HOOK_SESSION_INSTANCE_ID).toBeUndefined();
		expect(capturedEnv?.QUARTERDECK_SOME_FUTURE_VAR).toBeUndefined();
		expect(capturedEnv?.CLAUDECODE).toBeUndefined();
		expect(capturedEnv?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
		expect(capturedEnv?.CLAUDE_CODE_SSE_PORT).toBeUndefined();
		expect(capturedEnv?.CLAUDE_CODE_SESSION_ID).toBeUndefined();
		expect(capturedEnv?.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
		expect(capturedEnv?.CLAUDE_CODE_SESSION_ATTENDED).toBeUndefined();
		expect(capturedEnv?.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
		expect(capturedEnv?.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
		expect(capturedEnv?.CLAUDE_PID).toBeUndefined();
		expect(capturedEnv?.CLAUDE_EFFORT).toBeUndefined();
		expect(capturedEnv?.CLAUDE_CODE_EXECPATH).toBeUndefined();
		expect(capturedEnv?.ANTHROPIC_API_KEY).toBe("kept-api-key");
		expect(capturedEnv?.CLAUDE_CONFIG_DIR).toBe("/kept/config/dir");
		expect(capturedEnv?.CLAUDE_CODE_USE_BEDROCK).toBe("1");
		expect(capturedEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe("kept-oauth-token");

		delete process.env.QUARTERDECK_SOME_FUTURE_VAR;
		delete process.env.CLAUDE_CODE_SESSION_ID;
		delete process.env.CLAUDE_CODE_CHILD_SESSION;
		delete process.env.CLAUDE_CODE_SESSION_ATTENDED;
		delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
		delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
		delete process.env.CLAUDE_PID;
		delete process.env.CLAUDE_EFFORT;
		delete process.env.CLAUDE_CODE_EXECPATH;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CODE_USE_BEDROCK;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	});

	it("runs each call from a private per-call directory that is removed again afterward", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		let callback: ExecCallback | null = null;
		let capturedCwd: string | undefined;
		childProcessMocks.execFile.mockImplementation((...args: unknown[]) => {
			const candidate = args.at(-1);
			if (typeof candidate !== "function") {
				throw new Error("Expected execFile callback");
			}
			capturedCwd = (args[2] as { cwd?: string } | undefined)?.cwd;
			callback = candidate as typeof callback;
			return { stdin, stdout, stderr } as unknown as ChildProcess;
		});

		const resultPromise = _testing.runClaudeCommand(["-p"], 20_000, "title context");
		expect(capturedCwd).toBeDefined();
		expect(capturedCwd).not.toBe(tmpdir());
		expect(existsSync(capturedCwd as string)).toBe(true);
		requireExecCallback(callback)(null, jsonResult("Reliable Task Titles"), "");
		await resultPromise;

		expect(existsSync(capturedCwd as string)).toBe(false);
	});

	it("owns timeout termination instead of relying on execFile wrapper cleanup", async () => {
		vi.useFakeTimers();
		const kill = vi.fn(() => true);
		const unref = vi.fn();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		let callback: ExecCallback | null = null;
		childProcessMocks.execFile.mockImplementation((...args: unknown[]) => {
			const candidate = args.at(-1);
			if (typeof candidate !== "function") {
				throw new Error("Expected execFile callback");
			}
			if ((args[1] as string[] | undefined)?.includes("/pid")) {
				(candidate as ExecCallback)(null, "", "");
				return {} as ChildProcess;
			}
			callback = candidate as typeof callback;
			return { pid: 123, kill, unref, stdout, stderr } as unknown as ChildProcess;
		});

		const resultPromise = _testing.runClaudeCommand(["-p"], 20_000, "title context");
		const partialStdout = "private stdout ".repeat(60);
		const partialStderr = "private stderr ".repeat(60);
		stdout.write(partialStdout);
		stderr.write(partialStderr);
		await vi.advanceTimersByTimeAsync(20_000);

		if (process.platform === "win32") {
			expect(childProcessMocks.execFile.mock.calls.some((call) => call[1]?.includes("/pid"))).toBe(true);
			expect(kill).not.toHaveBeenCalled();
		} else {
			expect(kill).toHaveBeenCalledWith("SIGTERM");
		}
		expect(unref).toHaveBeenCalledOnce();
		await expect(resultPromise).resolves.toMatchObject({
			timedOut: true,
			signal: null,
			stdout: "",
			stderr: "",
			stdoutBytes: Buffer.byteLength(partialStdout),
			stderrBytes: Buffer.byteLength(partialStderr),
			errorClass: "TimeoutError",
		});

		// A late callback after the bounded result must be harmless.
		const timeoutError = Object.assign(new Error("timed out"), {
			code: null,
			killed: true,
			signal: "SIGTERM" as NodeJS.Signals,
		});
		requireExecCallback(callback)(timeoutError, "", "");
	});

	it("closes helper stdin so Claude does not wait for additional prompt input", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		let callback: ExecCallback | null = null;
		childProcessMocks.execFile.mockImplementation((...args: unknown[]) => {
			const candidate = args.at(-1);
			if (typeof candidate !== "function") {
				throw new Error("Expected execFile callback");
			}
			callback = candidate as typeof callback;
			return { stdin, stdout, stderr } as unknown as ChildProcess;
		});

		const resultPromise = _testing.runClaudeCommand(["-p"], 20_000, "title context");

		expect(stdin.writableEnded).toBe(true);
		expect(stdin.read()?.toString()).toBe("title context");
		requireExecCallback(callback)(null, jsonResult("Reliable Task Titles"), "");
		await expect(resultPromise).resolves.toMatchObject({
			exitStatus: 0,
			timedOut: false,
		});
	});
});
