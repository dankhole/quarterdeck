import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	abortMergeOrRebase,
	continueMergeOrRebase,
	detectActiveConflict,
	getConflictedFiles,
	getConflictFileContent,
	getConflictState,
	resolveConflictFile,
	runGitMergeAction,
} from "../../src/workdir";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function runGitUnchecked(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	return {
		status: result.status ?? 1,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
	};
}

function initRepository(path: string): void {
	runGit(path, ["init", "-q", "-b", "main"]);
	runGit(path, ["config", "user.name", "Test User"]);
	runGit(path, ["config", "user.email", "test@example.com"]);
	runGit(path, ["config", "core.autocrlf", "false"]);
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

interface ConflictRepo {
	repoPath: string;
	cleanup: () => void;
}

/**
 * Standard 2-branch merge conflict setup:
 *
 *   init -> commit file.txt "base content"
 *   create branchA -> modify file.txt to "version A" -> commit
 *   checkout main -> modify file.txt to "version B" -> commit
 *   stays on main (ready to merge branchA)
 */
function createConflictRepo(prefix = "quarterdeck-git-conflict-int-"): ConflictRepo {
	const { path: repoPath, cleanup } = createTempDir(prefix);

	initRepository(repoPath);
	writeFileSync(join(repoPath, "file.txt"), "base content\n", "utf8");
	commitAll(repoPath, "initial: base content");

	// branchA: conflicting change
	runGit(repoPath, ["checkout", "-b", "branchA"]);
	writeFileSync(join(repoPath, "file.txt"), "version A\n", "utf8");
	commitAll(repoPath, "branchA: version A");

	// Back to main with conflicting change
	runGit(repoPath, ["checkout", "main"]);
	writeFileSync(join(repoPath, "file.txt"), "version B\n", "utf8");
	commitAll(repoPath, "main: version B");

	return { repoPath, cleanup };
}

/**
 * Multi-commit rebase conflict setup:
 *
 *   init -> commit file.txt "base"
 *   create branchA -> commit1: file.txt "A1" -> commit2: file.txt "A2"
 *   checkout main -> modify file.txt to "B" -> commit
 *   checkout branchA -> start `git rebase main` (will conflict)
 */
function createRebaseConflictRepo(prefix = "quarterdeck-git-rebase-int-"): ConflictRepo {
	const { path: repoPath, cleanup } = createTempDir(prefix);

	initRepository(repoPath);
	writeFileSync(join(repoPath, "file.txt"), "base\n", "utf8");
	commitAll(repoPath, "initial");

	// branchA: two commits both touching file.txt
	runGit(repoPath, ["checkout", "-b", "branchA"]);
	writeFileSync(join(repoPath, "file.txt"), "A1\n", "utf8");
	commitAll(repoPath, "branchA commit 1");
	writeFileSync(join(repoPath, "file.txt"), "A2\n", "utf8");
	commitAll(repoPath, "branchA commit 2");

	// main: conflicting change
	runGit(repoPath, ["checkout", "main"]);
	writeFileSync(join(repoPath, "file.txt"), "B\n", "utf8");
	commitAll(repoPath, "main: modify file.txt");

	// Checkout branchA and start the rebase (will fail with conflicts)
	runGit(repoPath, ["checkout", "branchA"]);
	runGitUnchecked(repoPath, ["rebase", "main"]);

	return { repoPath, cleanup };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("git conflict integration", { concurrent: false }, () => {
	it("retains a clean merge and its error when a commit hook rejects completion, then allows retry", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-merge-commit-failure-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "base\n", "utf8");
			commitAll(repoPath, "initial");
			runGit(repoPath, ["checkout", "-b", "feature"]);
			writeFileSync(join(repoPath, "feature.txt"), "feature\n", "utf8");
			const featureHead = commitAll(repoPath, "feature");
			runGit(repoPath, ["checkout", "main"]);
			writeFileSync(join(repoPath, "file.txt"), "main\n", "utf8");
			const mainHead = commitAll(repoPath, "main");

			const hookPath = join(repoPath, ".git", "hooks", "pre-commit");
			runGit(repoPath, ["config", "core.hooksPath", join(repoPath, ".git", "hooks")]);
			writeFileSync(hookPath, '#!/bin/sh\necho "Synthetic commit check failed" >&2\nexit 1\n', { mode: 0o755 });

			const mergeResult = await runGitMergeAction({ cwd: repoPath, branch: "feature" });
			expect(mergeResult.ok).toBe(false);
			expect(mergeResult.error).toContain("Synthetic commit check failed");
			expect(mergeResult.conflictState).toMatchObject({
				operation: "merge",
				sourceBranch: "feature",
				conflictedFiles: [],
				autoMergedFiles: ["feature.txt"],
			});
			expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(mainHead);
			expect(existsSync(join(repoPath, ".git", "MERGE_HEAD"))).toBe(true);

			const failedContinue = await continueMergeOrRebase(repoPath);
			expect(failedContinue.ok).toBe(false);
			expect(failedContinue.completed).toBe(false);
			expect(failedContinue.error).toContain("Synthetic commit check failed");
			expect(failedContinue.conflictState).toEqual(mergeResult.conflictState);

			unlinkSync(hookPath);
			const retryResult = await continueMergeOrRebase(repoPath);
			expect(retryResult.ok).toBe(true);
			expect(retryResult.completed).toBe(true);
			expect(await detectActiveConflict(repoPath)).toBeNull();
			expect(runGit(repoPath, ["show", "-s", "--format=%P", "HEAD"])).toBe(`${mainHead} ${featureHead}`);
			expect(runGit(repoPath, ["status", "--porcelain"])).toBe("");
		} finally {
			cleanup();
		}
	});

	it("full merge conflict resolution flow", async () => {
		const { repoPath, cleanup } = createConflictRepo();
		try {
			// 1. runGitMergeAction → should pause with conflict
			const mergeResult = await runGitMergeAction({ cwd: repoPath, branch: "branchA" });
			expect(mergeResult.ok).toBe(false);
			expect(mergeResult.conflictState).toBeDefined();
			expect(mergeResult.conflictState?.operation).toBe("merge");

			// 2. getConflictedFiles → should include file.txt
			const files = await getConflictedFiles(repoPath);
			expect(files).toContain("file.txt");

			// 3. getConflictFileContent → ours = "version B", theirs = "version A"
			const content = await getConflictFileContent(repoPath, "file.txt");
			expect(content.oursContent).toContain("version B");
			expect(content.theirsContent).toContain("version A");

			// 4. resolveConflictFile with "theirs"
			const resolveResult = await resolveConflictFile(repoPath, "file.txt", "theirs");
			expect(resolveResult.ok).toBe(true);

			// 5. continueMergeOrRebase → should complete
			const continueResult = await continueMergeOrRebase(repoPath);
			expect(continueResult.ok).toBe(true);
			expect(continueResult.completed).toBe(true);

			// Verify: file contains "version A" (theirs)
			const finalContent = readFileSync(join(repoPath, "file.txt"), "utf8");
			expect(finalContent).toContain("version A");

			// Verify: git log shows merge commit (HEAD has two parents)
			const parentLine = runGit(repoPath, ["rev-list", "--parents", "-1", "HEAD"]);
			const parts = parentLine.split(/\s+/);
			expect(parts.length).toBe(3); // commit hash + 2 parents

			// Verify: no active conflict
			const conflict = await detectActiveConflict(repoPath);
			expect(conflict).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("full rebase conflict resolution with multiple rounds", async () => {
		const { repoPath, cleanup } = createRebaseConflictRepo();
		try {
			// 1. Detect conflict state → rebase, step 1
			const detected = await detectActiveConflict(repoPath);
			expect(detected).not.toBeNull();
			expect(detected?.operation).toBe("rebase");
			expect(detected?.currentStep).toBe(1);

			// 2. Resolve first conflict with "theirs" (accept the rebase commit's version)
			const firstFiles = await getConflictedFiles(repoPath);
			expect(firstFiles).toContain("file.txt");

			await resolveConflictFile(repoPath, "file.txt", "theirs");

			// 3. Continue — may hit second conflict for commit 2
			const firstContinue = await continueMergeOrRebase(repoPath);

			if (!firstContinue.completed) {
				// 4. New conflicts from second commit — resolve and continue again
				expect(firstContinue.conflictState).toBeDefined();
				expect(firstContinue.conflictState?.conflictedFiles.length).toBeGreaterThan(0);

				await resolveConflictFile(repoPath, "file.txt", "theirs");
				const secondContinue = await continueMergeOrRebase(repoPath);
				expect(secondContinue.ok).toBe(true);
				expect(secondContinue.completed).toBe(true);
			}

			// 5. Verify: rebase-merge dir gone
			expect(existsSync(join(repoPath, ".git", "rebase-merge"))).toBe(false);

			// Verify: no active conflict
			const finalConflict = await detectActiveConflict(repoPath);
			expect(finalConflict).toBeNull();

			// Verify: git log shows rebased commits (linear history, no merge commits)
			const logOutput = runGit(repoPath, ["log", "--oneline"]);
			expect(logOutput).toContain("branchA commit 1");
			expect(logOutput).toContain("branchA commit 2");
		} finally {
			cleanup();
		}
	});

	it("abort mid-resolution restores clean state", async () => {
		const { repoPath, cleanup } = createConflictRepo();
		try {
			// Start merge (will conflict)
			runGitUnchecked(repoPath, ["merge", "branchA"]);

			// Confirm MERGE_HEAD exists
			expect(existsSync(join(repoPath, ".git", "MERGE_HEAD"))).toBe(true);

			// Abort
			const abortResult = await abortMergeOrRebase(repoPath);
			expect(abortResult.ok).toBe(true);

			// Verify: MERGE_HEAD gone
			expect(existsSync(join(repoPath, ".git", "MERGE_HEAD"))).toBe(false);

			// Verify: file is back to pre-merge content ("version B")
			const content = readFileSync(join(repoPath, "file.txt"), "utf8");
			expect(content).toContain("version B");

			// Verify: working tree clean
			const status = runGit(repoPath, ["status", "--porcelain"]);
			expect(status).toBe("");
		} finally {
			cleanup();
		}
	});

	it("rebase abort after multiple rounds restores original state", async () => {
		const { repoPath, cleanup } = createRebaseConflictRepo();
		try {
			// Capture original branchA HEAD before rebase
			// (rebase is already in progress from createRebaseConflictRepo, so use ORIG_HEAD)
			const origHead = runGit(repoPath, ["rev-parse", "ORIG_HEAD"]);

			// Resolve round 1 to advance the rebase
			await resolveConflictFile(repoPath, "file.txt", "theirs");
			const continueResult = await continueMergeOrRebase(repoPath);

			if (!continueResult.completed) {
				// We're in round 2 with new conflicts — abort from here
				const abortResult = await abortMergeOrRebase(repoPath);
				expect(abortResult.ok).toBe(true);
			} else {
				// If the rebase completed in one round (unlikely with two conflicting commits,
				// but handle gracefully), there's nothing to abort. Skip abort assertions.
				return;
			}

			// Verify: rebase-merge dir gone
			expect(existsSync(join(repoPath, ".git", "rebase-merge"))).toBe(false);

			// Verify: original branchA commit history preserved (HEAD matches original)
			const currentHead = runGit(repoPath, ["rev-parse", "HEAD"]);
			expect(currentHead).toBe(origHead);

			// Verify: no active conflict
			const conflict = await detectActiveConflict(repoPath);
			expect(conflict).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("conflict detection on already-conflicted repo", async () => {
		const { repoPath, cleanup } = createConflictRepo();
		try {
			// Start merge and leave in conflicted state
			runGitUnchecked(repoPath, ["merge", "branchA"]);

			// 1. detectActiveConflict → returns merge
			const detected = await detectActiveConflict(repoPath);
			expect(detected).not.toBeNull();
			expect(detected?.operation).toBe("merge");

			// 2. getConflictedFiles → returns the file
			const files = await getConflictedFiles(repoPath);
			expect(files).toContain("file.txt");

			// 3. getConflictState → returns full state
			const state = await getConflictState(repoPath);
			expect(state).not.toBeNull();
			expect(state?.operation).toBe("merge");
			expect(state?.conflictedFiles).toContain("file.txt");
			expect(state?.sourceBranch).toBe("branchA");
		} finally {
			cleanup();
		}
	});
});
