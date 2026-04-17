import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
	runGitCheckoutAction,
	runGitSyncAction,
	stashApply,
	stashCount,
	stashDrop,
	stashList,
	stashPop,
	stashPush,
	stashShow,
} from "../../src/workdir";
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

function initRepository(path: string): void {
	runGit(path, ["init", "-q", "-b", "main"]);
	runGit(path, ["config", "user.name", "Test User"]);
	runGit(path, ["config", "user.email", "test@example.com"]);
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

function gitStatus(cwd: string): string {
	return runGit(cwd, ["status", "--porcelain"]);
}

function gitStashListRaw(cwd: string): string {
	return spawnSync("git", ["stash", "list"], {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	}).stdout.trim();
}

// ─── stashPush ──────────────────────────────────────────────────────────────

describe.sequential("stashPush", () => {
	it("stashes all changes including untracked", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-push-all-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "tracked.txt"), "original\n", "utf8");
			commitAll(repoPath, "initial");

			// Create a tracked modification and an untracked file.
			writeFileSync(join(repoPath, "tracked.txt"), "modified\n", "utf8");
			writeFileSync(join(repoPath, "untracked.txt"), "new file\n", "utf8");

			const result = await stashPush({ cwd: repoPath, paths: [] });
			expect(result.ok).toBe(true);

			// Working tree should be clean.
			const status = gitStatus(repoPath);
			expect(status).toBe("");

			// Stash list should have 1 entry.
			const stashListOutput = gitStashListRaw(repoPath);
			expect(stashListOutput.split("\n").filter(Boolean)).toHaveLength(1);

			// Pop and verify both files are restored.
			runGit(repoPath, ["stash", "pop"]);
			const trackedContent = readFileSync(join(repoPath, "tracked.txt"), "utf8");
			expect(trackedContent).toBe("modified\n");
			const untrackedContent = readFileSync(join(repoPath, "untracked.txt"), "utf8");
			expect(untrackedContent).toBe("new file\n");
		} finally {
			cleanup();
		}
	});

	it("stashes only selected paths", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-push-partial-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file1.txt"), "original1\n", "utf8");
			writeFileSync(join(repoPath, "file2.txt"), "original2\n", "utf8");
			writeFileSync(join(repoPath, "file3.txt"), "original3\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file1.txt"), "modified1\n", "utf8");
			writeFileSync(join(repoPath, "file2.txt"), "modified2\n", "utf8");
			writeFileSync(join(repoPath, "file3.txt"), "modified3\n", "utf8");

			const result = await stashPush({ cwd: repoPath, paths: ["file1.txt", "file2.txt"] });
			expect(result.ok).toBe(true);

			// file3.txt should still be modified.
			const status = gitStatus(repoPath);
			expect(status).toContain("file3.txt");
			expect(status).not.toContain("file1.txt");
			expect(status).not.toContain("file2.txt");

			// Pop and verify file1 and file2 are restored.
			runGit(repoPath, ["stash", "pop"]);
			expect(readFileSync(join(repoPath, "file1.txt"), "utf8")).toBe("modified1\n");
			expect(readFileSync(join(repoPath, "file2.txt"), "utf8")).toBe("modified2\n");
		} finally {
			cleanup();
		}
	});

	it("includes custom message", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-push-msg-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "original\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "modified\n", "utf8");

			const result = await stashPush({ cwd: repoPath, paths: [], message: "my custom stash" });
			expect(result.ok).toBe(true);

			const stashListOutput = gitStashListRaw(repoPath);
			expect(stashListOutput).toContain("my custom stash");
		} finally {
			cleanup();
		}
	});

	it("returns error when nothing to stash", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-push-clean-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "content\n", "utf8");
			commitAll(repoPath, "initial");

			const result = await stashPush({ cwd: repoPath, paths: [] });
			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		} finally {
			cleanup();
		}
	});

	it("rejects invalid paths via validateGitPath", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-push-traversal-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "content\n", "utf8");
			commitAll(repoPath, "initial");

			const result = await stashPush({ cwd: repoPath, paths: ["../outside.txt"] });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("Invalid file path");
		} finally {
			cleanup();
		}
	});
});

// ─── stashList ──────────────────────────────────────────────────────────────

describe.sequential("stashList", () => {
	it("returns empty array for no stashes", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-list-empty-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "content\n", "utf8");
			commitAll(repoPath, "initial");

			const result = await stashList(repoPath);
			expect(result.ok).toBe(true);
			expect(result.entries).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("parses entries with index, message, branch, date", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-list-parse-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "content\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "modified\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [], message: "test stash" });

			const result = await stashList(repoPath);
			expect(result.ok).toBe(true);
			expect(result.entries).toHaveLength(1);

			const entry = result.entries[0];
			expect(entry.index).toBe(0);
			expect(entry.message).toContain("test stash");
			expect(entry.branch).toBe("main");
			expect(entry.date).toBeTruthy();
		} finally {
			cleanup();
		}
	});

	it("handles multiple entries in stack order", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-list-multi-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "content\n", "utf8");
			commitAll(repoPath, "initial");

			// First stash.
			writeFileSync(join(repoPath, "file.txt"), "change-1\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [], message: "first stash" });

			// Second stash.
			writeFileSync(join(repoPath, "file.txt"), "change-2\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [], message: "second stash" });

			const result = await stashList(repoPath);
			expect(result.ok).toBe(true);
			expect(result.entries).toHaveLength(2);

			// Stack order: most recent at index 0.
			expect(result.entries[0].index).toBe(0);
			expect(result.entries[0].message).toContain("second stash");
			expect(result.entries[1].index).toBe(1);
			expect(result.entries[1].message).toContain("first stash");
		} finally {
			cleanup();
		}
	});
});

// ─── stashPop ───────────────────────────────────────────────────────────────

describe.sequential("stashPop", () => {
	it("restores changes and removes entry", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-pop-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "original\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "modified\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [] });

			// File should be back to original.
			expect(readFileSync(join(repoPath, "file.txt"), "utf8")).toBe("original\n");

			const result = await stashPop({ cwd: repoPath, index: 0 });
			expect(result.ok).toBe(true);
			expect(result.conflicted).toBe(false);

			// File should be restored.
			expect(readFileSync(join(repoPath, "file.txt"), "utf8")).toBe("modified\n");

			// Stash stack should be empty.
			const stashListOutput = gitStashListRaw(repoPath);
			expect(stashListOutput).toBe("");
		} finally {
			cleanup();
		}
	});

	it("detects conflict and retains entry", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-pop-conflict-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "A\n", "utf8");
			commitAll(repoPath, "initial");

			// Modify and stash.
			writeFileSync(join(repoPath, "a.txt"), "B\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [] });

			// Create a conflicting change and commit it so pop will conflict.
			writeFileSync(join(repoPath, "a.txt"), "C\n", "utf8");
			commitAll(repoPath, "conflicting change");

			const result = await stashPop({ cwd: repoPath, index: 0 });
			expect(result.ok).toBe(false);
			expect(result.conflicted).toBe(true);

			// Stash entry should still exist (not removed on conflict).
			const stashListOutput = gitStashListRaw(repoPath);
			expect(stashListOutput.split("\n").filter(Boolean)).toHaveLength(1);

			// Git repo should be in conflicted state.
			const unmerged = spawnSync("git", ["ls-files", "-u"], {
				cwd: repoPath,
				encoding: "utf8",
				env: createGitTestEnv(),
			}).stdout.trim();
			expect(unmerged).toBeTruthy();
		} finally {
			cleanup();
		}
	});
});

// ─── stashApply ─────────────────────────────────────────────────────────────

describe.sequential("stashApply", () => {
	it("restores changes and retains entry", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-apply-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "original\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "modified\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [] });

			const result = await stashApply({ cwd: repoPath, index: 0 });
			expect(result.ok).toBe(true);
			expect(result.conflicted).toBe(false);

			// File should be restored.
			expect(readFileSync(join(repoPath, "file.txt"), "utf8")).toBe("modified\n");

			// Stash entry should still exist (apply does not remove).
			const stashListOutput = gitStashListRaw(repoPath);
			expect(stashListOutput.split("\n").filter(Boolean)).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("detects conflict and retains entry", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-apply-conflict-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "A\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "a.txt"), "B\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [] });

			// Create conflicting change.
			writeFileSync(join(repoPath, "a.txt"), "C\n", "utf8");
			commitAll(repoPath, "conflicting change");

			const result = await stashApply({ cwd: repoPath, index: 0 });
			expect(result.ok).toBe(false);
			expect(result.conflicted).toBe(true);

			// Stash entry should still exist.
			const stashListOutput = gitStashListRaw(repoPath);
			expect(stashListOutput.split("\n").filter(Boolean)).toHaveLength(1);
		} finally {
			cleanup();
		}
	});
});

// ─── stashDrop ──────────────────────────────────────────────────────────────

describe.sequential("stashDrop", () => {
	it("removes entry without applying", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-drop-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "original\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "modified\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [] });

			const result = await stashDrop({ cwd: repoPath, index: 0 });
			expect(result.ok).toBe(true);

			// Stash should be empty.
			const stashListOutput = gitStashListRaw(repoPath);
			expect(stashListOutput).toBe("");

			// File should NOT be restored (drop, not pop).
			expect(readFileSync(join(repoPath, "file.txt"), "utf8")).toBe("original\n");
		} finally {
			cleanup();
		}
	});

	it("returns error for invalid index", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-drop-invalid-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "content\n", "utf8");
			commitAll(repoPath, "initial");

			// No stashes exist, so index 0 is invalid.
			const result = await stashDrop({ cwd: repoPath, index: 0 });
			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		} finally {
			cleanup();
		}
	});
});

// ─── stashShow ──────────────────────────────────────────────────────────────

describe.sequential("stashShow", () => {
	it("returns diff for stash entry", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-show-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "original\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "modified\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [] });

			const result = await stashShow({ cwd: repoPath, index: 0 });
			expect(result.ok).toBe(true);
			expect(result.diff).toBeDefined();
			expect(result.diff).toContain("file.txt");
			expect(result.diff).toContain("-original");
			expect(result.diff).toContain("+modified");
		} finally {
			cleanup();
		}
	});

	it("returns ok: false with no diff for invalid index", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-show-invalid-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "content\n", "utf8");
			commitAll(repoPath, "initial");

			// No stashes exist, so index 99 is invalid.
			const result = await stashShow({ cwd: repoPath, index: 99 });
			expect(result.ok).toBe(false);
			expect(result.diff).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});

// ─── stashCount ─────────────────────────────────────────────────────────────

describe.sequential("stashCount", () => {
	it("returns 0 for no stashes", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-count-zero-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "content\n", "utf8");
			commitAll(repoPath, "initial");

			const count = await stashCount(repoPath);
			expect(count).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("returns correct count", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-count-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "content\n", "utf8");
			commitAll(repoPath, "initial");

			// Create two stashes.
			writeFileSync(join(repoPath, "file.txt"), "change-1\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [], message: "stash one" });

			writeFileSync(join(repoPath, "file.txt"), "change-2\n", "utf8");
			await stashPush({ cwd: repoPath, paths: [], message: "stash two" });

			const count = await stashCount(repoPath);
			expect(count).toBe(2);
		} finally {
			cleanup();
		}
	});
});

// ─── edge cases ───────────────────────────────────────────────────────────────

describe.sequential("edge cases", () => {
	it("stashPop on empty stack returns error", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-pop-empty-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "content\n", "utf8");
			commitAll(repoPath, "initial");

			// No stashes exist, so pop should fail.
			const result = await stashPop({ cwd: repoPath, index: 0 });
			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		} finally {
			cleanup();
		}
	});

	it("stashPush partial with untracked files", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-push-partial-untracked-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "existing.txt"), "original\n", "utf8");
			commitAll(repoPath, "initial");

			// Create a tracked modification and an untracked new file.
			writeFileSync(join(repoPath, "existing.txt"), "modified\n", "utf8");
			writeFileSync(join(repoPath, "brand-new.txt"), "untracked content\n", "utf8");

			// Stash only the untracked file as a selected path.
			const result = await stashPush({ cwd: repoPath, paths: ["brand-new.txt"] });
			expect(result.ok).toBe(true);

			// The untracked file should be gone (stashed).
			const status = gitStatus(repoPath);
			expect(status).not.toContain("brand-new.txt");
			// The tracked modification should still be present.
			expect(status).toContain("existing.txt");

			// Pop and verify the untracked file is restored.
			runGit(repoPath, ["stash", "pop"]);
			const restored = readFileSync(join(repoPath, "brand-new.txt"), "utf8");
			expect(restored).toBe("untracked content\n");
		} finally {
			cleanup();
		}
	});

	it("stashList on repo with no commits", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-list-no-commits-");
		try {
			initRepository(repoPath);
			// No commits at all — stash list should handle gracefully.
			const result = await stashList(repoPath);
			expect(result.ok).toBe(true);
			expect(result.entries).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

// ─── dirtyTree detection ────────────────────────────────────────────────────

describe.sequential("dirtyTree detection", () => {
	it("runGitCheckoutAction returns dirtyTree: true on dirty working tree", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-stash-checkout-dirty-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "initial\n", "utf8");
			commitAll(repoPath, "initial commit");

			// Create a second branch with a different version of the file
			runGit(repoPath, ["checkout", "-b", "other"]);
			writeFileSync(join(repoPath, "file.txt"), "other branch content\n", "utf8");
			commitAll(repoPath, "other branch commit");

			// Switch back to main and modify the tracked file (don't commit)
			runGit(repoPath, ["checkout", "main"]);
			writeFileSync(join(repoPath, "file.txt"), "dirty uncommitted change\n", "utf8");

			const result = await runGitCheckoutAction({ cwd: repoPath, branch: "other" });

			expect(result.ok).toBe(false);
			expect(result.dirtyTree).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("runGitSyncAction pull returns dirtyTree: true on dirty working tree", async () => {
		const { path: bareDir, cleanup: cleanupBare } = createTempDir("quarterdeck-git-stash-pull-bare-");
		const { path: repoPath, cleanup: cleanupRepo } = createTempDir("quarterdeck-git-stash-pull-dirty-");
		try {
			// Create a bare remote repo
			runGit(bareDir, ["init", "-q", "--bare", "-b", "main"]);

			// Clone it to get a repo with a remote
			spawnSync("git", ["clone", "-q", bareDir, repoPath], {
				encoding: "utf8",
				env: createGitTestEnv(),
			});

			// Configure the clone
			runGit(repoPath, ["config", "user.name", "Test User"]);
			runGit(repoPath, ["config", "user.email", "test@example.com"]);

			// Create initial commit and push
			writeFileSync(join(repoPath, "file.txt"), "initial\n", "utf8");
			commitAll(repoPath, "initial commit");
			runGit(repoPath, ["push", "-u", "origin", "main"]);

			// Modify a tracked file without committing (make tree dirty)
			writeFileSync(join(repoPath, "file.txt"), "dirty change\n", "utf8");

			const result = await runGitSyncAction({ cwd: repoPath, action: "pull" });

			expect(result.ok).toBe(false);
			expect(result.dirtyTree).toBe(true);
		} finally {
			cleanupRepo();
			cleanupBare();
		}
	});
});
