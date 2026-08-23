import type { ChildProcess, ExecFileException } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

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
		exitStatus: number | null;
		signal: NodeJS.Signals | null;
		timedOut: boolean;
		errorMessage: string | null;
	}> = {},
) {
	return {
		isAvailable: vi.fn(() => true),
		run: vi.fn(async (_args: string[], _timeoutMs: number) => ({
			stdout: "Reliable Task Titles\n",
			stderr: "",
			exitStatus: 0,
			signal: null,
			timedOut: false,
			errorMessage: null,
			...result,
		})),
	};
}

afterEach(() => {
	vi.useRealTimers();
	childProcessMocks.execFile.mockReset();
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
		const executor = createExecutor({
			stdout: "",
			stderr: "authentication required",
			exitStatus: 1,
			errorMessage: "Command failed",
		});

		expect(await callCodex(OPTIONS, executor)).toBeNull();
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
		let callback: ExecCallback | null = null;
		childProcessMocks.execFile.mockImplementation((...args: unknown[]) => {
			const candidate = args.at(-1);
			if (typeof candidate !== "function") {
				throw new Error("Expected execFile callback");
			}
			callback = candidate as typeof callback;
			return { pid: 123, kill, unref } as unknown as ChildProcess;
		});

		const resultPromise = _testing.runCodexCommand(["exec", "--", "title"], 20_000);
		await vi.advanceTimersByTimeAsync(20_000);

		expect(kill).toHaveBeenCalledWith("SIGTERM");
		expect(unref).toHaveBeenCalledOnce();
		await expect(resultPromise).resolves.toMatchObject({ timedOut: true, signal: null });

		// A late callback after the bounded result must be harmless.
		const timeoutError = Object.assign(new Error("timed out"), {
			code: null,
			killed: true,
			signal: "SIGTERM" as NodeJS.Signals,
		});
		requireExecCallback(callback)(timeoutError, "", "");
	});
});
