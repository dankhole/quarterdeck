import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { commitSelectedFiles, discardSingleFile } from "../../src/workspace";
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
	runGit(path, ["init", "-q"]);
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

describe.sequential("commitSelectedFiles", () => {
	it("commits only specified paths", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-selective-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "original a\n", "utf8");
			writeFileSync(join(repoPath, "b.txt"), "original b\n", "utf8");
			writeFileSync(join(repoPath, "c.txt"), "original c\n", "utf8");
			commitAll(repoPath, "initial");

			// Modify all three files.
			writeFileSync(join(repoPath, "a.txt"), "modified a\n", "utf8");
			writeFileSync(join(repoPath, "b.txt"), "modified b\n", "utf8");
			writeFileSync(join(repoPath, "c.txt"), "modified c\n", "utf8");

			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: ["a.txt", "b.txt"],
				message: "commit only a and b",
			});

			expect(result.ok).toBe(true);

			// Verify a.txt and b.txt are committed (not in status output).
			const status = gitStatus(repoPath);
			expect(status).not.toContain("a.txt");
			expect(status).not.toContain("b.txt");
			// c.txt should still be modified.
			expect(status).toContain("c.txt");
		} finally {
			cleanup();
		}
	});

	it("handles untracked files", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-untracked-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "base.txt"), "base\n", "utf8");
			commitAll(repoPath, "initial");

			// Create a new untracked file.
			writeFileSync(join(repoPath, "new-file.txt"), "brand new\n", "utf8");

			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: ["new-file.txt"],
				message: "add new file",
			});

			expect(result.ok).toBe(true);

			// The file should now be tracked (not in status output).
			const status = gitStatus(repoPath);
			expect(status).not.toContain("new-file.txt");

			// Verify file exists in HEAD.
			const showOutput = runGit(repoPath, ["show", "HEAD:new-file.txt"]);
			expect(showOutput).toBe("brand new");
		} finally {
			cleanup();
		}
	});

	it("returns commit hash", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-hash-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "hello\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "changed\n", "utf8");

			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: ["file.txt"],
				message: "update file",
			});

			expect(result.ok).toBe(true);
			expect(result.commitHash).toBeDefined();

			const headHash = runGit(repoPath, ["rev-parse", "HEAD"]);
			// commitHash is an abbreviated hash; HEAD is the full hash. Check that HEAD starts with it.
			expect(headHash.startsWith(result.commitHash as string)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("fails with empty paths array", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-empty-paths-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "hello\n", "utf8");
			commitAll(repoPath, "initial");

			// git add with no paths after -- is a no-op, then commit should fail with nothing staged.
			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: [],
				message: "should fail",
			});

			// git add -- (with no paths) succeeds but stages nothing, then git commit fails.
			expect(result.ok).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("fails with empty message", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-empty-msg-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "hello\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "changed\n", "utf8");

			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: ["file.txt"],
				message: "",
			});

			expect(result.ok).toBe(false);

			// File should be unstaged after rollback.
			const status = gitStatus(repoPath);
			expect(status).toContain("file.txt");
			expect(status).not.toMatch(/^A /m); // Not staged as "added".
		} finally {
			cleanup();
		}
	});

	it("rolls back staging on commit failure", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-rollback-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "hello\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "changed\n", "utf8");

			// Use empty message to trigger commit failure.
			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: ["file.txt"],
				message: "",
			});

			expect(result.ok).toBe(false);

			// After rollback, file should appear as a worktree modification, not staged.
			// Use raw spawnSync to preserve the leading space in porcelain output.
			const rawStatus = spawnSync("git", ["status", "--porcelain"], {
				cwd: repoPath,
				encoding: "utf8",
				env: createGitTestEnv(),
			}).stdout;
			// Porcelain format: " M file.txt" for unstaged modification (space in column 1).
			// "M  file.txt" would be staged.
			expect(rawStatus).toMatch(/^ M file\.txt/m);
		} finally {
			cleanup();
		}
	});

	it("rejects path traversal", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-traversal-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "hello\n", "utf8");
			commitAll(repoPath, "initial");

			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: ["../outside.txt"],
				message: "sneaky commit",
			});

			expect(result.ok).toBe(false);
			expect(result.error).toContain("Invalid file path");
		} finally {
			cleanup();
		}
	});
});

describe.sequential("discardSingleFile", () => {
	it("restores tracked modified file", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-discard-modified-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "original content\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "modified content\n", "utf8");

			const result = await discardSingleFile({
				cwd: repoPath,
				path: "file.txt",
				fileStatus: "modified",
			});

			expect(result.ok).toBe(true);
			const content = readFileSync(join(repoPath, "file.txt"), "utf8");
			expect(content).toBe("original content\n");
		} finally {
			cleanup();
		}
	});

	it("removes untracked file", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-discard-untracked-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "base.txt"), "base\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "new-file.txt"), "untracked\n", "utf8");
			expect(existsSync(join(repoPath, "new-file.txt"))).toBe(true);

			const result = await discardSingleFile({
				cwd: repoPath,
				path: "new-file.txt",
				fileStatus: "untracked",
			});

			expect(result.ok).toBe(true);
			expect(existsSync(join(repoPath, "new-file.txt"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("restores tracked deleted file", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-discard-deleted-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "will be deleted\n", "utf8");
			commitAll(repoPath, "initial");

			unlinkSync(join(repoPath, "file.txt"));
			expect(existsSync(join(repoPath, "file.txt"))).toBe(false);

			const result = await discardSingleFile({
				cwd: repoPath,
				path: "file.txt",
				fileStatus: "deleted",
			});

			expect(result.ok).toBe(true);
			expect(existsSync(join(repoPath, "file.txt"))).toBe(true);
			const content = readFileSync(join(repoPath, "file.txt"), "utf8");
			expect(content).toBe("will be deleted\n");
		} finally {
			cleanup();
		}
	});

	it("handles staged file", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-discard-staged-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "original\n", "utf8");
			commitAll(repoPath, "initial");

			writeFileSync(join(repoPath, "file.txt"), "staged change\n", "utf8");
			runGit(repoPath, ["add", "file.txt"]);

			// Confirm the file is staged.
			const statusBefore = gitStatus(repoPath);
			expect(statusBefore).toMatch(/^M/m);

			const result = await discardSingleFile({
				cwd: repoPath,
				path: "file.txt",
				fileStatus: "modified",
			});

			expect(result.ok).toBe(true);

			// Both staging area and worktree should be restored.
			const statusAfter = gitStatus(repoPath);
			expect(statusAfter).not.toContain("file.txt");

			const content = readFileSync(join(repoPath, "file.txt"), "utf8");
			expect(content).toBe("original\n");
		} finally {
			cleanup();
		}
	});

	it("rejects path traversal", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-discard-traversal-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "hello\n", "utf8");
			commitAll(repoPath, "initial");

			const result = await discardSingleFile({
				cwd: repoPath,
				path: "../outside.txt",
				fileStatus: "modified",
			});

			expect(result.ok).toBe(false);
			expect(result.error).toContain("Invalid file path");
		} finally {
			cleanup();
		}
	});

	it("rejects renamed files", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-discard-renamed-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "hello\n", "utf8");
			commitAll(repoPath, "initial");

			const result = await discardSingleFile({
				cwd: repoPath,
				path: "file.txt",
				fileStatus: "renamed",
			});

			expect(result.ok).toBe(false);
			expect(result.error).toContain("Cannot rollback renamed/copied");
		} finally {
			cleanup();
		}
	});

	it("rejects copied files", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-discard-copied-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "hello\n", "utf8");
			commitAll(repoPath, "initial");

			const result = await discardSingleFile({
				cwd: repoPath,
				path: "file.txt",
				fileStatus: "copied",
			});

			expect(result.ok).toBe(false);
			expect(result.error).toContain("Cannot rollback renamed/copied");
		} finally {
			cleanup();
		}
	});
});
