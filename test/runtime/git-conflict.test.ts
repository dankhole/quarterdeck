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
	resolveConflictFile,
	runGitMergeAction,
} from "../../src/workspace/git-conflict";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

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

/**
 * Like runGit but does not throw on non-zero exit — returns the exit code.
 * Used for commands that are expected to fail (e.g. merge with conflicts).
 */
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
	runGit(path, ["init", "-q"]);
	runGit(path, ["config", "user.name", "Test User"]);
	runGit(path, ["config", "user.email", "test@example.com"]);
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

interface ConflictRepo {
	repoPath: string;
	cleanup: () => void;
	conflictBranch: string;
}

/**
 * Creates a temp git repo with two branches that conflict on `file.txt`:
 *
 *   init -> commit file.txt "base content"
 *   create branchA -> modify file.txt to "branch A content" -> commit
 *   checkout main -> modify file.txt to "main content" -> commit
 *   stay on main (ready to merge branchA which will conflict)
 */
function createMergeConflictRepo(prefix = "quarterdeck-git-conflict-"): ConflictRepo {
	const { path: repoPath, cleanup } = createTempDir(prefix);

	initRepository(repoPath);
	writeFileSync(join(repoPath, "file.txt"), "base content\n", "utf8");
	commitAll(repoPath, "initial: base content");

	// Create branchA with conflicting change
	runGit(repoPath, ["checkout", "-b", "branchA"]);
	writeFileSync(join(repoPath, "file.txt"), "branch A content\n", "utf8");
	commitAll(repoPath, "branchA: modify file.txt");

	// Go back to main and make a conflicting change
	runGit(repoPath, ["checkout", "main"]);
	writeFileSync(join(repoPath, "file.txt"), "main content\n", "utf8");
	commitAll(repoPath, "main: modify file.txt");

	return { repoPath, cleanup, conflictBranch: "branchA" };
}

// ---------------------------------------------------------------------------
// detectActiveConflict
// ---------------------------------------------------------------------------

describe.sequential("detectActiveConflict", () => {
	it("returns null for clean repo", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-conflict-clean-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "hello\n", "utf8");
			commitAll(repoPath, "initial");

			const result = await detectActiveConflict(repoPath);
			expect(result).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("detects active merge", async () => {
		const { repoPath, cleanup, conflictBranch } = createMergeConflictRepo();
		try {
			// Attempt merge — will fail with conflicts
			runGitUnchecked(repoPath, ["merge", conflictBranch]);

			const result = await detectActiveConflict(repoPath);
			expect(result).not.toBeNull();
			expect(result?.operation).toBe("merge");
			expect(result?.sourceBranch).toBe("branchA");
			expect(result?.currentStep).toBeNull();
			expect(result?.totalSteps).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("detects active rebase", async () => {
		const { repoPath, cleanup } = createMergeConflictRepo();
		try {
			// Checkout branchA and rebase onto main — will fail with conflicts
			runGit(repoPath, ["checkout", "branchA"]);
			runGitUnchecked(repoPath, ["rebase", "main"]);

			const result = await detectActiveConflict(repoPath);
			expect(result).not.toBeNull();
			expect(result?.operation).toBe("rebase");
			expect(result?.currentStep).toBeTypeOf("number");
			expect(result?.currentStep).toBeGreaterThan(0);
			expect(result?.totalSteps).toBeTypeOf("number");
			expect(result?.totalSteps).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// getConflictedFiles
// ---------------------------------------------------------------------------

describe.sequential("getConflictedFiles", () => {
	it("lists all conflicted paths", async () => {
		const { repoPath, cleanup, conflictBranch } = createMergeConflictRepo();
		try {
			runGitUnchecked(repoPath, ["merge", conflictBranch]);

			const files = await getConflictedFiles(repoPath);
			expect(files).toContain("file.txt");
		} finally {
			cleanup();
		}
	});

	it("returns empty for resolved conflicts", async () => {
		const { repoPath, cleanup, conflictBranch } = createMergeConflictRepo();
		try {
			runGitUnchecked(repoPath, ["merge", conflictBranch]);

			// Resolve the conflict by choosing ours and staging
			runGit(repoPath, ["checkout", "--ours", "--", "file.txt"]);
			runGit(repoPath, ["add", "file.txt"]);

			const files = await getConflictedFiles(repoPath);
			expect(files).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// getConflictFileContent
// ---------------------------------------------------------------------------

describe.sequential("getConflictFileContent", () => {
	it("returns ours and theirs content", async () => {
		const { repoPath, cleanup, conflictBranch } = createMergeConflictRepo();
		try {
			runGitUnchecked(repoPath, ["merge", conflictBranch]);

			const content = await getConflictFileContent(repoPath, "file.txt");
			expect(content.path).toBe("file.txt");
			// We are on main, so "ours" = main content, "theirs" = branchA content
			expect(content.oursContent).toContain("main content");
			expect(content.theirsContent).toContain("branch A content");
		} finally {
			cleanup();
		}
	});

	it("handles deleted-on-one-side", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-conflict-delete-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "base content\n", "utf8");
			commitAll(repoPath, "initial");

			// branchA: delete the file
			runGit(repoPath, ["checkout", "-b", "branchA"]);
			unlinkSync(join(repoPath, "file.txt"));
			runGit(repoPath, ["add", "."]);
			runGit(repoPath, ["commit", "-qm", "delete file.txt"]);

			// main: modify the file
			runGit(repoPath, ["checkout", "main"]);
			writeFileSync(join(repoPath, "file.txt"), "modified on main\n", "utf8");
			commitAll(repoPath, "modify file.txt on main");

			// Merge branchA — should conflict (modify/delete)
			runGitUnchecked(repoPath, ["merge", "branchA"]);

			const content = await getConflictFileContent(repoPath, "file.txt");
			expect(content.path).toBe("file.txt");
			// Ours (main) modified the file, theirs (branchA) deleted it
			expect(content.oursContent).toContain("modified on main");
			// theirs deleted — stage 3 won't exist, so empty string
			expect(content.theirsContent).toBe("");
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// resolveConflictFile
// ---------------------------------------------------------------------------

describe.sequential("resolveConflictFile", () => {
	it("resolves with ours correctly", async () => {
		const { repoPath, cleanup, conflictBranch } = createMergeConflictRepo();
		try {
			runGitUnchecked(repoPath, ["merge", conflictBranch]);

			const result = await resolveConflictFile(repoPath, "file.txt", "ours");
			expect(result.ok).toBe(true);

			// File content should be "main content" (ours)
			const fileContent = readFileSync(join(repoPath, "file.txt"), "utf8");
			expect(fileContent).toContain("main content");

			// File should no longer appear in unmerged list
			const unmerged = runGit(repoPath, ["ls-files", "-u"]);
			expect(unmerged).not.toContain("file.txt");

			// File should be staged (no longer in unmerged state).
			// When resolving with "ours", content matches HEAD so diff --cached may be empty,
			// but the unmerged entry being gone confirms staging succeeded.
		} finally {
			cleanup();
		}
	});

	it("resolves with theirs correctly", async () => {
		const { repoPath, cleanup, conflictBranch } = createMergeConflictRepo();
		try {
			runGitUnchecked(repoPath, ["merge", conflictBranch]);

			const result = await resolveConflictFile(repoPath, "file.txt", "theirs");
			expect(result.ok).toBe(true);

			// File content should be "branch A content" (theirs)
			const fileContent = readFileSync(join(repoPath, "file.txt"), "utf8");
			expect(fileContent).toContain("branch A content");
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// continueMergeOrRebase
// ---------------------------------------------------------------------------

describe.sequential("continueMergeOrRebase", () => {
	it("completes merge after all conflicts resolved", async () => {
		const { repoPath, cleanup, conflictBranch } = createMergeConflictRepo();
		try {
			runGitUnchecked(repoPath, ["merge", conflictBranch]);

			// Resolve all conflicts
			runGit(repoPath, ["checkout", "--ours", "--", "file.txt"]);
			runGit(repoPath, ["add", "file.txt"]);

			const result = await continueMergeOrRebase(repoPath);
			expect(result.ok).toBe(true);
			expect(result.completed).toBe(true);

			// Verify merge commit exists — HEAD should have two parents
			const parentCount = runGit(repoPath, ["rev-list", "--parents", "-1", "HEAD"]);
			const parents = parentCount.split(/\s+/);
			// First is the commit hash itself, then parent hashes
			expect(parents.length).toBe(3); // commit + 2 parents = merge commit
		} finally {
			cleanup();
		}
	});

	it("handles multi-step rebase with successive conflicts", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-conflict-rebase-multi-");
		try {
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
			writeFileSync(join(repoPath, "file.txt"), "main\n", "utf8");
			commitAll(repoPath, "main: modify file.txt");

			// Start rebase of branchA onto main
			runGit(repoPath, ["checkout", "branchA"]);
			runGitUnchecked(repoPath, ["rebase", "main"]);

			// Resolve first conflict
			const firstConflictFiles = await getConflictedFiles(repoPath);
			expect(firstConflictFiles).toContain("file.txt");

			await resolveConflictFile(repoPath, "file.txt", "theirs");
			const firstContinue = await continueMergeOrRebase(repoPath);

			// Either completes or has new conflicts for the second commit
			if (!firstContinue.completed) {
				expect(firstContinue.conflictState).toBeDefined();
				expect(firstContinue.conflictState?.conflictedFiles.length).toBeGreaterThan(0);

				// Resolve second round
				await resolveConflictFile(repoPath, "file.txt", "theirs");
				const secondContinue = await continueMergeOrRebase(repoPath);
				expect(secondContinue.ok).toBe(true);
				expect(secondContinue.completed).toBe(true);
			}

			// Either way, rebase should be complete now
			const conflict = await detectActiveConflict(repoPath);
			expect(conflict).toBeNull();
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// abortMergeOrRebase
// ---------------------------------------------------------------------------

describe.sequential("abortMergeOrRebase", () => {
	it("aborts merge", async () => {
		const { repoPath, cleanup, conflictBranch } = createMergeConflictRepo();
		try {
			runGitUnchecked(repoPath, ["merge", conflictBranch]);

			// Verify MERGE_HEAD exists before abort
			expect(existsSync(join(repoPath, ".git", "MERGE_HEAD"))).toBe(true);

			const result = await abortMergeOrRebase(repoPath);
			expect(result.ok).toBe(true);

			// MERGE_HEAD should be gone
			expect(existsSync(join(repoPath, ".git", "MERGE_HEAD"))).toBe(false);

			// Working tree should be clean
			const status = runGit(repoPath, ["status", "--porcelain"]);
			expect(status).toBe("");
		} finally {
			cleanup();
		}
	});

	it("aborts rebase", async () => {
		const { repoPath, cleanup } = createMergeConflictRepo();
		try {
			runGit(repoPath, ["checkout", "branchA"]);
			runGitUnchecked(repoPath, ["rebase", "main"]);

			// Verify rebase-merge dir exists before abort
			expect(existsSync(join(repoPath, ".git", "rebase-merge"))).toBe(true);

			const result = await abortMergeOrRebase(repoPath);
			expect(result.ok).toBe(true);

			// rebase-merge dir should be gone
			expect(existsSync(join(repoPath, ".git", "rebase-merge"))).toBe(false);
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// runGitMergeAction
// ---------------------------------------------------------------------------

describe.sequential("runGitMergeAction", () => {
	it("pauses on conflict instead of aborting", async () => {
		const { repoPath, cleanup, conflictBranch } = createMergeConflictRepo();
		try {
			const result = await runGitMergeAction({ cwd: repoPath, branch: conflictBranch });

			expect(result.ok).toBe(false);
			expect(result.conflictState).toBeDefined();
			expect(result.conflictState?.operation).toBe("merge");

			// MERGE_HEAD should still exist (not auto-aborted)
			expect(existsSync(join(repoPath, ".git", "MERGE_HEAD"))).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("still aborts on non-conflict errors", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-conflict-nonexistent-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "hello\n", "utf8");
			commitAll(repoPath, "initial");

			const result = await runGitMergeAction({ cwd: repoPath, branch: "nonexistent-branch" });

			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.conflictState).toBeUndefined();

			// No MERGE_HEAD should exist
			expect(existsSync(join(repoPath, ".git", "MERGE_HEAD"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("succeeds for clean merge", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-conflict-clean-merge-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "base\n", "utf8");
			commitAll(repoPath, "initial");

			// Create a branch that modifies a DIFFERENT file — no conflict
			runGit(repoPath, ["checkout", "-b", "featureB"]);
			writeFileSync(join(repoPath, "other.txt"), "feature B content\n", "utf8");
			commitAll(repoPath, "featureB: add other.txt");

			runGit(repoPath, ["checkout", "main"]);

			const result = await runGitMergeAction({ cwd: repoPath, branch: "featureB" });

			expect(result.ok).toBe(true);
			expect(result.conflictState).toBeUndefined();

			// Verify the merged file exists
			expect(existsSync(join(repoPath, "other.txt"))).toBe(true);
		} finally {
			cleanup();
		}
	});
});
