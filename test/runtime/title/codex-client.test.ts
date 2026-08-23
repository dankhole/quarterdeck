import type { ChildProcess, ExecFileException } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _resetLoggerForTests, type RuntimeDiagnosticLogSink, setRuntimeDiagnosticLogSink } from "../../../src/core";

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

import { _testing, callCodex } from "../../../src/title/codex-client";

const OPTIONS = {
	systemPrompt: "Return only a concise title.",
	userPrompt: "make title generation reliable",
	timeoutMs: 20_000,
	model: "gpt-5.6-luna",
};

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
		run: vi.fn(async (_args: string[], _timeoutMs: number) => ({
			stdout: "Reliable Task Titles\n",
			stderr: "",
			stdoutBytes: 21,
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
});

describe("callCodex", () => {
	it("returns the sanitized final Codex message", async () => {
		const executor = createExecutor({ stdout: "Title: Reliable Task Titles\n" });

		expect(await callCodex(OPTIONS, executor)).toBe("Reliable Task Titles");
		expect(executor.run).toHaveBeenCalledWith(expect.any(Array), 20_000);
	});

	it("uses an isolated ephemeral read-only invocation", async () => {
		const executor = createExecutor();

		await callCodex(OPTIONS, executor);

		const args = executor.run.mock.calls[0]?.[0] ?? [];
		expect(args).toEqual(
			expect.arrayContaining([
				"exec",
				"--ephemeral",
				"--ignore-user-config",
				"--ignore-rules",
				"--skip-git-repo-check",
				"--sandbox",
				"read-only",
			]),
		);
		expect(args.at(-2)).toBe("--");
		expect(args.at(-1)).toContain("<input-context>\nmake title generation reliable\n</input-context>");
		const modelIndex = args.indexOf("--model");
		expect(args[modelIndex + 1]).toBe("gpt-5.6-luna");
		const reasoningConfig = args.find((arg) => arg.startsWith("model_reasoning_effort="));
		expect(reasoningConfig).toBe('model_reasoning_effort="none"');
		const developerConfig = args.find((arg) => arg.startsWith("developer_instructions="));
		expect(developerConfig).toContain("Return only a concise title");
		expect(developerConfig).toContain("Do not use tools or inspect files");
	});

	it("does not spawn when Codex is unavailable", async () => {
		const executor = createExecutor();
		executor.isAvailable.mockReturnValue(false);

		expect(await callCodex(OPTIONS, executor)).toBeNull();
		expect(executor.run).not.toHaveBeenCalled();
	});

	it("returns null when the Codex process fails", async () => {
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

		expect(await callCodex(OPTIONS, executor)).toBeNull();
		const failure = logs.find(
			(entry) => entry.tag === "codex-helper" && entry.message === "Codex helper call failed",
		);
		expect(failure?.data).toMatchObject({
			errorClass: "ExecFileError",
			stdoutBytes: 23,
			stderrBytes: 20,
		});
		expect(JSON.stringify(failure?.data)).not.toContain("private");
	});

	it("keeps the prompt after an explicit option separator", () => {
		const args = _testing.buildCodexExecArgs({ ...OPTIONS, userPrompt: "- investigate title failures" });

		expect(args.at(-2)).toBe("--");
		expect(args.at(-1)).toContain("- investigate title failures");
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
			callback = candidate as typeof callback;
			return { pid: 123, kill, unref, stdout, stderr } as unknown as ChildProcess;
		});

		const resultPromise = _testing.runCodexCommand(["exec", "--", "title"], 20_000);
		const partialStdout = "private stdout ".repeat(60);
		const partialStderr = "private stderr ".repeat(60);
		stdout.write(partialStdout);
		stderr.write(partialStderr);
		await vi.advanceTimersByTimeAsync(20_000);

		expect(kill).toHaveBeenCalledWith("SIGTERM");
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

	it("closes helper stdin so Codex does not wait for additional prompt input", async () => {
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

		const resultPromise = _testing.runCodexCommand(["exec", "--", "title"], 20_000);

		expect(stdin.writableEnded).toBe(true);
		requireExecCallback(callback)(null, "Reliable Task Titles\n", "");
		await expect(resultPromise).resolves.toMatchObject({
			exitStatus: 0,
			stdout: "Reliable Task Titles\n",
			timedOut: false,
		});
	});
});
