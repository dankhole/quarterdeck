import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGitCommandArgs } from "../../src/core";

const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
	// Populated with the real `execFile` below so specific tests can prove real
	// child-process timing behavior without disabling this file's module mock.
	realExecFile: null as unknown as typeof import("node:child_process").execFile,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	childProcessMocks.realExecFile = actual.execFile;
	return {
		execFile: Object.assign(childProcessMocks.execFile, {
			[promisify.custom]: childProcessMocks.execFilePromise,
		}),
	};
});

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

	it("returns unknown after a ref-resolution execution failure", async () => {
		childProcessMocks.execFilePromise.mockRejectedValueOnce(createExecError({ code: "ETIMEDOUT" }));
		await expect(workdirExports.getCommitsBehindBase("/repo", "main")).resolves.toBeNull();
		expect(childProcessMocks.execFilePromise).toHaveBeenCalledTimes(1);
	});

	it.each([
		["ENOENT", "spawn_unavailable", "ENOENT"],
		["EACCES", "permission_denied", "EACCES"],
		["EPERM", "permission_denied", "EPERM"],
		["ETIMEDOUT", "timed_out", "ETIMEDOUT"],
		[128, "command_failed", null],
		["private-error-sentinel", "command_failed", null],
	])("retains bounded failure metadata for code %s", async (code, failureKind, errorCode) => {
		childProcessMocks.execFilePromise.mockRejectedValueOnce(createExecError({ code: code as string | number }));
		expect(await runGit("/repo", ["rev-parse", "--show-toplevel"])).toMatchObject({
			ok: false,
			failureKind,
			errorCode,
		});
	});

	it.each([null, "", "invalid", "3 partial", "9007199254740992"])(
		"returns unknown rather than zero for failed or malformed behind counts: %s",
		async (count) => {
			childProcessMocks.execFilePromise.mockImplementation((_command: string, args: string[]) => {
				if (args.includes("rev-list")) {
					if (count === null) return Promise.reject(createExecError({ code: 128 }));
					return Promise.resolve({ stdout: count, stderr: "" });
				}
				return Promise.resolve({ stdout: "abc123\n", stderr: "" });
			});
			await expect(workdirExports.getCommitsBehindBase("/repo", "main")).resolves.toBeNull();
		},
	);

	it("does not classify non-process failures as git exit code 1", async () => {
		childProcessMocks.execFilePromise.mockRejectedValueOnce(
			Object.assign(
				createExecError({
					code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
					stdout: "partial-output",
					stderr: "remote: Counting objects: 10%\rremote: Counting objects: 20%\n",
					message: "stdout maxBuffer length exceeded",
				}),
				{ killed: true, signal: "SIGTERM" },
			),
		);

		const result = await runGit("/repo", ["diff", "--binary", "HEAD", "--"], { trimStdout: false });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(-1);
		expect(result.stdout).toBe("partial-output");
		expect(result.error).toBe("stdout maxBuffer length exceeded");
		expect(result.output).toContain("remote: Counting objects: 10%\rremote: Counting objects: 20%");
		expect(result.errorCode).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
		expect(result.timedOut).toBe(false);
	});

	it("flags termination by an external signal (e.g. an OOM kill) separately from our own timeout", async () => {
		// An external SIGKILL (not our own timeout path, which reports killed:true
		// with SIGTERM) leaves `code` null and `killed` unset.
		childProcessMocks.execFilePromise.mockRejectedValueOnce(
			Object.assign(createExecError({ code: 137, message: "Killed" }), { code: null, signal: "SIGKILL" }),
		);

		const result = await runGit("/repo", ["status"]);

		expect(result).toMatchObject({ ok: false, timedOut: false, terminatedBySignal: true });
	});

	it("does not flag our own timeout termination as an external signal kill", async () => {
		childProcessMocks.execFilePromise.mockRejectedValueOnce(
			Object.assign(new Error("Git command timed out after 5000ms"), {
				code: "ETIMEDOUT",
				killed: true,
				signal: "SIGTERM",
			}),
		);

		const result = await runGit("/repo", ["status"]);

		expect(result).toMatchObject({ ok: false, timedOut: true, terminatedBySignal: false });
	});

	it("keeps normal Git stderr as the error while retaining all command output", async () => {
		const stderr = "remote: Counting objects: 100%\r\nfatal: could not read from remote repository.\n";
		childProcessMocks.execFilePromise.mockRejectedValueOnce(
			createExecError({ code: 128, stdout: "partial output\n", stderr, message: "Command failed" }),
		);

		const result = await runGit("/repo", ["status"]);

		expect(result.error).toBe(stderr.trim());
		expect(result.output).toBe(`partial output\n${stderr.trim()}`);
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
				gitCallback?.(new Error("terminated"), "partial", "remote: Receiving objects: 12%\r");
				return true;
			});
			childProcessMocks.execFile.mockImplementation(
				(_command: string, args: string[], _options: unknown, execCallback: typeof gitCallback) => {
					if (args.includes("/pid")) {
						execCallback?.(null, "", "");
						gitCallback?.(new Error("terminated"), "partial", "remote: Receiving objects: 12%\r");
						return { pid: 54_321, kill: vi.fn(() => true), exitCode: null, signalCode: null };
					}
					gitCallback = execCallback;
					return { pid: 12_345, kill, exitCode: null, signalCode: null };
				},
			);

			const resultPromise = runGit("/repo", ["status"], { timeoutClass: "metadata" });
			await vi.runAllTimersAsync();
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
				stderr: "remote: Receiving objects: 12%",
				output: "partial\nremote: Receiving objects: 12%",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	// Real-process tests below delegate the module-mocked `execFile` to the real
	// implementation and route a fake "git" binary through PATH, proving `runGit`'s
	// actual timing behavior end to end (no execFile mock deciding the outcome).
	describe("runGit against real child processes", () => {
		let scriptDir: string;

		beforeEach(() => {
			childProcessMocks.execFile.mockImplementation(childProcessMocks.realExecFile);
			scriptDir = mkdtempSync(join(tmpdir(), "qd-git-utils-real-"));
		});

		afterEach(() => {
			rmSync(scriptDir, { recursive: true, force: true });
		});

		/** Writes an executable shell script named "git" and returns an env whose PATH finds it first. */
		function fakeGitEnv(script: string): NodeJS.ProcessEnv {
			const scriptPath = join(scriptDir, "git");
			writeFileSync(scriptPath, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
			return { ...process.env, PATH: `${scriptDir}:${process.env.PATH ?? ""}` };
		}

		it("tolerates a real event-loop stall without reporting a false timeout", async () => {
			const resultPromise = runGit(process.cwd(), ["rev-parse", "--show-toplevel"], { timeoutMs: 150 });
			// Real event-loop stall: the real `git` process exits almost immediately,
			// then the main thread is blocked synchronously well past the timeout
			// before we ever look at the result.
			const blockUntil = Date.now() + 400;
			while (Date.now() < blockUntil) {
				// busy-wait
			}
			await expect(resultPromise).resolves.toMatchObject({ ok: true, timedOut: false });
		}, 10_000);

		it.runIf(process.platform !== "win32")(
			"still terminates a real hung child and reports a timeout",
			async () => {
				// A plain hang (no git subcommand reliably blocks without flakiness);
				// `exec sleep` replaces the shell in place so SIGTERM reaches it directly.
				const env = fakeGitEnv("exec sleep 60");
				await expect(runGit(scriptDir, ["status"], { timeoutMs: 150, env })).resolves.toMatchObject({
					ok: false,
					timedOut: true,
					failureKind: "timed_out",
				});
			},
			10_000,
		);

		it.runIf(process.platform !== "win32")(
			"reports a timeout after the close grace period when a grandchild still holds stdio open",
			async () => {
				// The fake "git" backgrounds (and disowns, so the shell itself exits
				// quickly) a descendant that inherits its stdout/stderr and keeps the
				// pipe open past the close grace period, so 'close' (and the exec
				// callback) lags well behind the direct child's own exit.
				const env = fakeGitEnv("sleep 1.5 &\ndisown\nexit 0");
				await expect(runGit(scriptDir, ["status"], { timeoutMs: 300, env })).resolves.toMatchObject({
					ok: false,
					timedOut: true,
					failureKind: "timed_out",
				});
			},
			10_000,
		);
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
