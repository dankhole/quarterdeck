import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	commitSelectedPaths: vi.fn(),
	getGitSyncSummary: vi.fn(),
	runGit: vi.fn(),
}));

vi.mock("../../src/workdir/git-selected-commit", () => ({
	commitSelectedPaths: mocks.commitSelectedPaths,
}));
vi.mock("../../src/workdir/git-probe", () => ({
	getGitSyncSummary: mocks.getGitSyncSummary,
}));
vi.mock("../../src/workdir/git-utils", () => ({
	resolveRepoRoot: vi.fn(async (cwd: string) => cwd),
	validateGitPath: vi.fn(() => true),
	runGit: mocks.runGit,
}));

import { runtimeGitCommitResponseSchema } from "../../src/core/api/git-sync";
import { commitSelectedFiles } from "../../src/workdir/git-sync";

describe("selected commit completion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.runGit.mockReset();
		mocks.getGitSyncSummary.mockRejectedValue(new Error("unrelated metadata scan failed"));
	});

	it.each([
		{ ok: true, commitHash: "abc1234", output: "committed" },
		{ ok: false, error: "pre-commit hook failed", output: "hook output" },
	])("returns the Git result without scanning the remaining worktree: $ok", async (gitResult) => {
		mocks.commitSelectedPaths.mockResolvedValue(gitResult);

		const result = await commitSelectedFiles({ cwd: "/repo", paths: ["selected.txt"], message: "Selected" });

		expect(result).toEqual(gitResult);
		expect(runtimeGitCommitResponseSchema.parse(result)).toEqual(gitResult);
		expect(mocks.getGitSyncSummary).not.toHaveBeenCalled();
		expect(mocks.runGit).not.toHaveBeenCalled();
	});

	it.each([
		{ ok: true, error: null },
		{ ok: false, error: "remote rejected the push" },
	])("returns commit and push outcomes without another worktree scan: $ok", async (pushResult) => {
		const commitResult = { ok: true, commitHash: "abc1234", output: "committed" };
		mocks.commitSelectedPaths.mockResolvedValue(commitResult);
		mocks.runGit.mockResolvedValue(pushResult);

		const result = await commitSelectedFiles({
			cwd: "/repo",
			paths: ["selected.txt"],
			message: "Selected",
			pushAfterCommit: true,
		});

		expect(result).toEqual({
			...commitResult,
			pushOk: pushResult.ok,
			...(!pushResult.ok && { pushError: pushResult.error }),
		});
		expect(mocks.runGit).toHaveBeenCalledExactlyOnceWith("/repo", ["push"], { timeoutClass: "userAction" });
		expect(mocks.getGitSyncSummary).not.toHaveBeenCalled();
	});

	it("preserves commit success when pushing throws", async () => {
		mocks.commitSelectedPaths.mockResolvedValue({ ok: true, commitHash: "abc1234", output: "committed" });
		mocks.runGit.mockRejectedValue(new Error("push process failed"));

		await expect(
			commitSelectedFiles({ cwd: "/repo", paths: ["selected.txt"], message: "Selected", pushAfterCommit: true }),
		).resolves.toEqual({
			ok: true,
			commitHash: "abc1234",
			output: "committed",
			pushOk: false,
			pushError: "push process failed",
		});
		expect(mocks.getGitSyncSummary).not.toHaveBeenCalled();
	});

	it("does not push after a failed commit", async () => {
		const commitResult = { ok: false, output: "hook output", error: "pre-commit hook failed" };
		mocks.commitSelectedPaths.mockResolvedValue(commitResult);

		await expect(
			commitSelectedFiles({ cwd: "/repo", paths: ["selected.txt"], message: "Selected", pushAfterCommit: true }),
		).resolves.toEqual(commitResult);
		expect(mocks.runGit).not.toHaveBeenCalled();
		expect(mocks.getGitSyncSummary).not.toHaveBeenCalled();
	});

	it("waits for Git and its hooks before pushing and returning success", async () => {
		let finishCommit: ((result: { ok: boolean; commitHash: string; output: string }) => void) | undefined;
		mocks.commitSelectedPaths.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishCommit = resolve;
				}),
		);
		mocks.runGit.mockResolvedValue({ ok: true });
		const completed = vi.fn();
		const pending = commitSelectedFiles({
			cwd: "/repo",
			paths: ["selected.txt"],
			message: "Selected",
			pushAfterCommit: true,
		}).then(completed);
		await vi.waitFor(() => expect(mocks.commitSelectedPaths).toHaveBeenCalled());
		expect(completed).not.toHaveBeenCalled();
		expect(mocks.runGit).not.toHaveBeenCalled();

		finishCommit?.({ ok: true, commitHash: "abc1234", output: "committed" });
		await pending;
		expect(completed).toHaveBeenCalledWith({ ok: true, commitHash: "abc1234", output: "committed", pushOk: true });
	});
});
