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
import {
	GIT_FOREGROUND_RESERVED_SLOTS,
	GIT_PROCESS_CONCURRENCY_LIMIT,
	GIT_USER_ACTION_CONCURRENCY_LIMIT,
	getGitProcessLimiterSnapshot,
	isGitCommandIndeterminate,
	resolveGitProcessPriority,
} from "../../src/workdir/git-utils";

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

	describe("resolveRepoRoot", () => {
		it("surfaces a distinct retryable error when the toplevel lookup times out, instead of 'no repository'", async () => {
			childProcessMocks.execFilePromise.mockRejectedValueOnce(
				Object.assign(new Error("Git command timed out after 5000ms"), {
					code: "ETIMEDOUT",
					killed: true,
					signal: "SIGTERM",
				}),
			);

			await expect(workdirExports.resolveRepoRoot("/repo")).rejects.toThrow("Git did not respond in time; retry.");
		});

		it("still reports no repository for a genuine non-timeout failure", async () => {
			childProcessMocks.execFilePromise.mockRejectedValueOnce(createExecError({ code: 128 }));

			await expect(workdirExports.resolveRepoRoot("/repo")).rejects.toThrow(
				"No git repository detected for this project.",
			);
		});

		it("accepts a caller-supplied timeout class instead of always running on the short default", async () => {
			childProcessMocks.execFilePromise.mockResolvedValueOnce({ stdout: "/repo\n", stderr: "" });

			await expect(workdirExports.resolveRepoRoot("/repo", { timeoutClass: "userAction" })).resolves.toBe("/repo");
		});
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
			// Heavy machine load can push a single spawn's fork/exec past a tight
			// probe window, so keep the probe timeout generous and the stall
			// margin past it; the test still proves stall tolerance.
			const probeTimeoutMs = 3_000;
			const resultPromise = runGit(process.cwd(), ["rev-parse", "--show-toplevel"], {
				timeoutMs: probeTimeoutMs,
			});
			// Process admission is asynchronous: let the command spawn and arm its
			// timeout before stalling.
			await new Promise((resolveSpawn) => setImmediate(resolveSpawn));
			// Real event-loop stall: the real `git` process exits on its own, then
			// the main thread is blocked synchronously well past the timeout
			// before we ever look at the result.
			const blockUntil = Date.now() + probeTimeoutMs + 500;
			while (Date.now() < blockUntil) {
				// busy-wait
			}
			await expect(resultPromise).resolves.toMatchObject({ ok: true, timedOut: false });
		}, 15_000);

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

	it("treats Windows spawn permission failures and NTSTATUS exits as indeterminate", () => {
		const failure = { ok: false, timedOut: false, errorCode: null } as const;
		expect(
			isGitCommandIndeterminate(
				{ ...failure, failureKind: "permission_denied", exitCode: -1, errorCode: "EPERM" },
				"win32",
			),
		).toBe(true);
		expect(
			isGitCommandIndeterminate(
				{ ...failure, failureKind: "permission_denied", exitCode: -1, errorCode: "EPERM" },
				"darwin",
			),
		).toBe(false);
		expect(
			isGitCommandIndeterminate({ ...failure, failureKind: "command_failed", exitCode: 0xc0000005 }, "win32"),
		).toBe(true);
		expect(isGitCommandIndeterminate({ ...failure, failureKind: "command_failed", exitCode: 128 }, "win32")).toBe(
			false,
		);
		expect(
			isGitCommandIndeterminate(
				{ ...failure, failureKind: "spawn_unavailable", exitCode: -1, errorCode: "ENOENT" },
				"win32",
			),
		).toBe(false);
		expect(isGitCommandIndeterminate({ ...failure, failureKind: "queue_timed_out", exitCode: -1 }, "darwin")).toBe(
			true,
		);
	});

	it("treats external signal deaths and resource-exhaustion spawn errors as indeterminate on every platform", () => {
		const failure = { ok: false, timedOut: false, failureKind: "command_failed", errorCode: null } as const;
		for (const platform of ["darwin", "linux", "win32"] as const) {
			expect(isGitCommandIndeterminate({ ...failure, exitCode: -1, terminatedBySignal: true }, platform)).toBe(true);
			for (const errorCode of ["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"] as const) {
				expect(isGitCommandIndeterminate({ ...failure, exitCode: -1, errorCode }, platform)).toBe(true);
			}
			// Git's own exit status, or a bounded definite error, is an answer.
			expect(isGitCommandIndeterminate({ ...failure, exitCode: 128 }, platform)).toBe(false);
			expect(
				isGitCommandIndeterminate(
					{ ...failure, exitCode: -1, errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
					platform,
				),
			).toBe(false);
		}
	});

	it("classifies every timeout class explicitly for process admission", () => {
		expect(resolveGitProcessPriority({})).toBe("foreground");
		expect(resolveGitProcessPriority({ timeoutClass: "sync" })).toBe("foreground");
		expect(resolveGitProcessPriority({ timeoutClass: "userAction" })).toBe("userAction");
		expect(resolveGitProcessPriority({ timeoutClass: "metadata" })).toBe("background");
		expect(resolveGitProcessPriority({ timeoutClass: "inspection" })).toBe("background");
		expect(resolveGitProcessPriority({ timeoutClass: "remoteFetch" })).toBe("background");
		expect(resolveGitProcessPriority({ timeoutClass: "metadata", priority: "foreground" })).toBe("foreground");
	});

	it("keeps metadata commands runnable while the user-action cap is saturated", async () => {
		vi.useFakeTimers();
		const releases: Array<() => void> = [];
		const held: Array<ReturnType<typeof runGit>> = [];
		try {
			childProcessMocks.execFile.mockImplementation(
				(_command: string, args: string[], _options: unknown, callback: (...values: unknown[]) => void) => {
					if (args.includes("hold")) releases.push(() => callback(null, "held", ""));
					else callback(null, "metadata", "");
					return { pid: 12_345, kill: vi.fn(() => true) };
				},
			);
			held.push(
				...Array.from({ length: GIT_USER_ACTION_CONCURRENCY_LIMIT + 1 }, () =>
					runGit("/repo", ["hold"], { timeoutClass: "userAction" }),
				),
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(releases).toHaveLength(3);
			expect(getGitProcessLimiterSnapshot()).toMatchObject({
				userActionLimit: 3,
				activeByPriority: { userAction: 3 },
				queued: { userAction: 1 },
			});
			await expect(runGit("/repo", ["status"], { timeoutClass: "metadata" })).resolves.toMatchObject({
				ok: true,
				stdout: "metadata",
			});
		} finally {
			while (getGitProcessLimiterSnapshot().active > 0) {
				for (const release of releases.splice(0)) release();
				await vi.advanceTimersByTimeAsync(0);
			}
			await Promise.all(held);
			vi.useRealTimers();
		}
	});

	it("starts a queued command's timeout only after it is admitted, and cancels queued commands", async () => {
		vi.useFakeTimers();
		const releases: Array<() => void> = [];
		try {
			childProcessMocks.execFile.mockImplementation(
				(_command: string, args: string[], _options: unknown, callback: (...values: unknown[]) => void) => {
					if (args.includes("hold")) releases.push(() => callback(null, "held", ""));
					else callback(null, "quick", "");
					return { pid: 12_345, kill: vi.fn(() => true) };
				},
			);
			const backgroundCapacity = GIT_PROCESS_CONCURRENCY_LIMIT - GIT_FOREGROUND_RESERVED_SLOTS;
			const held = Array.from({ length: GIT_PROCESS_CONCURRENCY_LIMIT }, (_value, index) =>
				runGit("/repo", ["hold"], { timeoutClass: index < backgroundCapacity ? "metadata" : "sync" }),
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(getGitProcessLimiterSnapshot().active).toBe(GIT_PROCESS_CONCURRENCY_LIMIT);

			const queued = runGit("/repo", ["status"], { timeoutMs: 50 });
			const controller = new AbortController();
			const cancelled = runGit("/repo", ["status"], { timeoutClass: "metadata", signal: controller.signal });
			await vi.advanceTimersByTimeAsync(1_000);
			controller.abort();
			await expect(cancelled).resolves.toMatchObject({ ok: false, failureKind: "aborted" });

			releases.shift()?.();
			await expect(queued).resolves.toMatchObject({ ok: true, stdout: "quick" });
			for (const release of releases.splice(0)) release();
			await Promise.all(held);
			expect(getGitProcessLimiterSnapshot()).toMatchObject({ active: 0 });
		} finally {
			for (const release of releases) release();
			vi.useRealTimers();
		}
	});
});
