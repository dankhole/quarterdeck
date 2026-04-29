import { promisify } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

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

	it("passes the default timeout to child_process execFile", async () => {
		childProcessMocks.execFilePromise.mockResolvedValueOnce({ stdout: "ok\n", stderr: "" });

		await runGit("/repo", ["status"]);

		expect(childProcessMocks.execFilePromise).toHaveBeenCalledWith(
			"git",
			["-c", "core.quotepath=false", "status"],
			expect.objectContaining({ timeout: GIT_COMMAND_TIMEOUTS_MS.default }),
		);
	});

	it("passes explicit inspection and checkpoint timeout classes to child_process execFile", async () => {
		childProcessMocks.execFilePromise
			.mockResolvedValueOnce({ stdout: "ok\n", stderr: "" })
			.mockResolvedValueOnce({ stdout: "ok\n", stderr: "" });

		await runGit("/repo", ["show", "HEAD:file.txt"], { timeoutClass: "inspection" });
		await runGit("/repo", ["write-tree"], { timeoutClass: "checkpoint" });

		expect(childProcessMocks.execFilePromise).toHaveBeenNthCalledWith(
			1,
			"git",
			["-c", "core.quotepath=false", "show", "HEAD:file.txt"],
			expect.objectContaining({ timeout: GIT_COMMAND_TIMEOUTS_MS.inspection }),
		);
		expect(childProcessMocks.execFilePromise).toHaveBeenNthCalledWith(
			2,
			"git",
			["-c", "core.quotepath=false", "write-tree"],
			expect.objectContaining({ timeout: GIT_COMMAND_TIMEOUTS_MS.checkpoint }),
		);
	});

	it("classifies timed-out git commands distinctly", async () => {
		const error = createExecError({
			code: "ETIMEDOUT",
			stdout: "",
			stderr: "",
			message: "Command failed: git status",
		});
		childProcessMocks.execFilePromise.mockRejectedValueOnce(error);

		const result = await runGit("/repo", ["status"], { timeoutClass: "metadata" });

		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.error).toBe(`Git command timed out after ${GIT_COMMAND_TIMEOUTS_MS.metadata}ms`);
	});
});

describe("workdir git exports", () => {
	it("does not expose a synchronous git helper from the workdir barrel", () => {
		expect(workdirExports).not.toHaveProperty("runGitSync");
	});
});
