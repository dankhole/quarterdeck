import { promisify } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGitCommandArgs } from "../../src/core";

const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(childProcessMocks.execFile, {
		[promisify.custom]: childProcessMocks.execFilePromise,
	}),
}));

import * as workdirExports from "../../src/workdir";
import { GIT_COMMAND_TIMEOUTS_MS, runGit } from "../../src/workdir";

function createExecError(options: {
	code: string | number;
	stdout?: string;
	stderr?: string;
	message?: string;
}): Error & { code: string | number; stdout: string; stderr: string } {
	const error = new Error(options.message ?? "git failed") as Error & {
		code: string | number;
		stdout: string;
		stderr: string;
	};
	error.code = options.code;
	error.stdout = options.stdout ?? "";
	error.stderr = options.stderr ?? "";
	return error;
}

describe("runGit", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
		childProcessMocks.execFile.mockImplementation(
			(command: string, args: string[], options: unknown, callback: (...values: unknown[]) => void) => {
				const child = { pid: 12_345, kill: vi.fn(() => true) };
				void childProcessMocks.execFilePromise(command, args, options).then(
					(result: { stdout?: unknown; stderr?: unknown }) =>
						callback(null, result.stdout ?? "", result.stderr ?? ""),
					(error: { stdout?: unknown; stderr?: unknown }) =>
						callback(error, error.stdout ?? "", error.stderr ?? ""),
				);
				return child;
			},
		);
	});

	it("preserves raw stdout on exit code 1 when trimStdout is false", async () => {
		const diffOutput = "diff --git a/file b/file\n";
		childProcessMocks.execFilePromise.mockRejectedValueOnce(
			createExecError({
				code: 1,
				stdout: diffOutput,
				stderr: "",
			}),
		);

		const result = await runGit("/repo", ["diff", "--binary", "HEAD", "--"], { trimStdout: false });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe(diffOutput);
	});

	it("does not classify non-process failures as git exit code 1", async () => {
		childProcessMocks.execFilePromise.mockRejectedValueOnce(
			createExecError({
				code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
				stdout: "partial-output",
				stderr: "",
				message: "stdout maxBuffer length exceeded",
			}),
		);

		const result = await runGit("/repo", ["diff", "--binary", "HEAD", "--"], { trimStdout: false });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(-1);
		expect(result.stdout).toBe("partial-output");
	});

	it("launches git without a shell and hides its Windows console", async () => {
		childProcessMocks.execFilePromise.mockResolvedValueOnce({ stdout: "ok\n", stderr: "" });

		await runGit("/repo", ["status"]);

		expect(childProcessMocks.execFile).toHaveBeenCalledWith(
			process.platform === "win32" ? expect.stringMatching(/git\.exe$/iu) : "git",
			buildGitCommandArgs(["status"]),
			expect.objectContaining({ windowsHide: true }),
			expect.any(Function),
		);
	});

	it("preserves valid filename whitespace in NUL-delimited ref listings", async () => {
		childProcessMocks.execFilePromise.mockResolvedValueOnce({
			stdout: " leading.txt\0nested/file.ts\0",
			stderr: "",
		});

		await expect(workdirExports.listFilesAtRef("/repo", "HEAD")).resolves.toEqual([" leading.txt", "nested/file.ts"]);
		expect(childProcessMocks.execFile).toHaveBeenCalledWith(
			process.platform === "win32" ? expect.stringMatching(/git\.exe$/iu) : "git",
			buildGitCommandArgs(["ls-tree", "-r", "--name-only", "-z", "HEAD", "--"]),
			expect.objectContaining({ windowsHide: true }),
			expect.any(Function),
		);
	});

	it("tree-terminates and distinctly classifies a manually timed-out git command", async () => {
		vi.useFakeTimers();
		try {
			let gitCallback: ((error: Error | null, stdout: string, stderr: string) => void) | null = null;
			const kill = vi.fn(() => {
				gitCallback?.(new Error("terminated"), "partial", "");
				return true;
			});
			childProcessMocks.execFile.mockImplementation(
				(_command: string, args: string[], _options: unknown, execCallback: typeof gitCallback) => {
					if (args.includes("/pid")) {
						execCallback?.(null, "", "");
						gitCallback?.(new Error("terminated"), "partial", "");
						return { pid: 54_321, kill: vi.fn(() => true) };
					}
					gitCallback = execCallback;
					return { pid: 12_345, kill };
				},
			);

			const resultPromise = runGit("/repo", ["status"], { timeoutClass: "metadata" });
			await vi.advanceTimersByTimeAsync(GIT_COMMAND_TIMEOUTS_MS.metadata);
			const result = await resultPromise;

			if (process.platform === "win32") {
				expect(childProcessMocks.execFile.mock.calls.some((call) => call[1]?.includes("/pid"))).toBe(true);
				expect(kill).not.toHaveBeenCalled();
			} else {
				expect(kill).toHaveBeenCalledWith("SIGTERM");
			}
			expect(result).toMatchObject({
				ok: false,
				timedOut: true,
				error: `Git command timed out after ${GIT_COMMAND_TIMEOUTS_MS.metadata}ms`,
				stdout: "partial",
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("workdir git exports", () => {
	it("does not expose a synchronous git helper from the workdir barrel", () => {
		expect(workdirExports).not.toHaveProperty("runGitSync");
	});

	it("allows double-dot file names while rejecting traversal and absolute paths", () => {
		expect(workdirExports.validateGitPath("..notes")).toBe(true);
		expect(workdirExports.validateGitPath("notes..txt")).toBe(true);
		for (const path of ["../outside.txt", "nested/../outside.txt", "/absolute.txt"]) {
			expect(workdirExports.validateGitPath(path), path).toBe(false);
		}
		expect(workdirExports.validateGitPath("C:\\absolute.txt", "win32")).toBe(false);
		expect(workdirExports.validateGitPath("nested\\..\\outside.txt", "win32")).toBe(false);
		expect(workdirExports.validateGitPath("literal\\name.txt", "linux")).toBe(true);
	});

	it("preserves whitespace in NUL-delimited numstat paths and rename destinations", () => {
		const stats = workdirExports.parseNumstatPerFile("1\t2\t leading.txt\0" + "3\t4\t\0 old.txt\0 new.txt\0");

		expect([...stats.entries()]).toEqual([
			[" leading.txt", { additions: 1, deletions: 2 }],
			[" new.txt", { additions: 3, deletions: 4 }],
		]);
	});
});
