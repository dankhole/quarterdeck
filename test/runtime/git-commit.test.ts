import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { commitSelectedFiles, discardSingleFile } from "../../src/workdir";
import {
	stageAndCommitAll as commitAll,
	commitAll as commitAllAndReadHead,
	createGitTestEnv,
	initGitRepository as initRepository,
	runGit,
} from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function gitStatus(cwd: string): string {
	return runGit(cwd, ["status", "--porcelain"]);
}

describe("commitSelectedFiles", { concurrent: false }, () => {
	it.each([false, true])("commits already-staged ignored additions (initial commit: %s)", async (initial) => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-ignored-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "base.txt"), "base\n");
			if (!initial) commitAll(repoPath, "initial");
			writeFileSync(join(repoPath, "[generated].txt"), "staged\n");
			runGit(repoPath, ["--literal-pathspecs", "add", "--", "[generated].txt"]);
			writeFileSync(join(repoPath, "[generated].txt"), "latest\n");
			writeFileSync(join(repoPath, ".gitignore"), "*.txt\n");
			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: ["[generated].txt", ".gitignore"],
				message: "selected",
			});
			expect(result.ok, result.error).toBe(true);
			expect(runGit(repoPath, ["show", "HEAD:[generated].txt"])).toBe("latest");
		} finally {
			cleanup();
		}
	});

	it("does not commit ignored children when a tracked file becomes a directory", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-directory-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, ".gitignore"), "*.secret\n");
			writeFileSync(join(repoPath, "replaced"), "tracked\n");
			commitAll(repoPath, "initial");
			unlinkSync(join(repoPath, "replaced"));
			mkdirSync(join(repoPath, "replaced"));
			writeFileSync(join(repoPath, "replaced", "private.secret"), "private\n");
			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: ["replaced"],
				message: "remove tracked file",
			});
			expect(result.ok, result.error).toBe(true);
			expect(runGit(repoPath, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe(".gitignore");
			expect(runGit(repoPath, ["ls-files"])).toBe(".gitignore");
			expect(readFileSync(join(repoPath, "replaced", "private.secret"), "utf8")).toBe("private\n");
		} finally {
			cleanup();
		}
	});

	it.each([false, true])(
		"commits staged file/directory replacements (directory to file: %s)",
		async (directoryToFile) => {
			const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-replacement-");
			try {
				initRepository(repoPath);
				const oldPath = directoryToFile ? "replaced/child.txt" : "replaced";
				const newPath = directoryToFile ? "replaced" : "replaced/child.txt";
				if (directoryToFile) mkdirSync(join(repoPath, "replaced"));
				writeFileSync(join(repoPath, oldPath), "before\n");
				commitAll(repoPath, "initial");
				unlinkSync(join(repoPath, oldPath));
				if (directoryToFile) rmdirSync(join(repoPath, "replaced"));
				else mkdirSync(join(repoPath, "replaced"));
				writeFileSync(join(repoPath, newPath), "after\n");
				runGit(repoPath, ["add", "-A"]);
				const result = await commitSelectedFiles({ cwd: repoPath, paths: [oldPath, newPath], message: "replace" });
				expect(result.ok, result.error).toBe(true);
				expect(runGit(repoPath, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe(newPath);
				expect(runGit(repoPath, ["show", `HEAD:${newPath}`])).toBe("after");
				expect(gitStatus(repoPath)).toBe("");
			} finally {
				cleanup();
			}
		},
	);

	it("rejects untracked ignored selections without changing HEAD or the index", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-untracked-ignored-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, ".gitignore"), "ignored.txt\n");
			const head = commitAllAndReadHead(repoPath, "initial");
			writeFileSync(join(repoPath, "ignored.txt"), "private\n");
			const index = runGit(repoPath, ["write-tree"]);
			const result = await commitSelectedFiles({ cwd: repoPath, paths: ["ignored.txt"], message: "selected" });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("ignored.txt");
			expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(head);
			expect(runGit(repoPath, ["write-tree"])).toBe(index);
		} finally {
			cleanup();
		}
	});

	it("keeps same-size unselected edits visible when index stat data is racily clean", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-racy-index-");
		try {
			initRepository(repoPath);
			runGit(repoPath, ["config", "core.checkStat", "minimal"]);
			runGit(repoPath, ["config", "core.trustctime", "false"]);
			const timestamp = Math.floor(Date.now() / 1000) - 10;
			writeFileSync(join(repoPath, "selected.txt"), "original\n");
			writeFileSync(join(repoPath, "unselected.txt"), "original\n");
			utimesSync(join(repoPath, "unselected.txt"), timestamp, timestamp);
			commitAll(repoPath, "initial");
			utimesSync(join(repoPath, ".git", "index"), timestamp, timestamp);
			writeFileSync(join(repoPath, "selected.txt"), "selected change\n");
			writeFileSync(join(repoPath, "unselected.txt"), "modified\n");
			utimesSync(join(repoPath, "unselected.txt"), timestamp, timestamp);
			const result = await commitSelectedFiles({ cwd: repoPath, paths: ["selected.txt"], message: "selected" });
			expect(result.ok, result.error).toBe(true);
			expect(runGit(repoPath, ["show", "HEAD:unselected.txt"])).toBe("original");
			expect(gitStatus(repoPath)).toBe("M unselected.txt");
		} finally {
			cleanup();
		}
	});

	it("respects an existing Git index lock", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-locked-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "file.txt"), "original\n");
			const head = commitAllAndReadHead(repoPath, "initial");
			writeFileSync(join(repoPath, "file.txt"), "modified\n");
			writeFileSync(join(repoPath, ".git", "index.lock"), "another operation");
			const result = await commitSelectedFiles({ cwd: repoPath, paths: ["file.txt"], message: "blocked" });
			expect(result.ok).toBe(false);
			expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(head);
			expect(readFileSync(join(repoPath, ".git", "index.lock"), "utf8")).toBe("another operation");
		} finally {
			cleanup();
		}
	});

	it("commits a staged deletion alone without re-adding its retained copy", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-deletion-only-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "generated.txt"), "retained\n");
			commitAll(repoPath, "initial");
			runGit(repoPath, ["rm", "--cached", "generated.txt"]);
			const result = await commitSelectedFiles({ cwd: repoPath, paths: ["generated.txt"], message: "untrack" });
			expect(result.ok, result.error).toBe(true);
			expect(runGit(repoPath, ["ls-tree", "--name-only", "HEAD"])).toBe("");
			expect(readFileSync(join(repoPath, "generated.txt"), "utf8")).toBe("retained\n");
			expect(gitStatus(repoPath)).toBe("?? generated.txt");
		} finally {
			cleanup();
		}
	});

	it.each([false, true])(
		"commits unstaged deletions under an ignored directory (parent retained: %s)",
		async (retainParent) => {
			const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-unstaged-deletion-");
			try {
				initRepository(repoPath);
				mkdirSync(join(repoPath, "outputs"));
				const deletedPath = "outputs/[generated].txt";
				writeFileSync(join(repoPath, deletedPath), "generated file\n");
				writeFileSync(join(repoPath, "selected.txt"), "original\n");
				writeFileSync(join(repoPath, "unselected.txt"), "original\n");
				commitAll(repoPath, "initial");
				unlinkSync(join(repoPath, deletedPath));
				if (retainParent) writeFileSync(join(repoPath, "outputs", "private.txt"), "ignored content\n");
				else rmdirSync(join(repoPath, "outputs"));
				writeFileSync(join(repoPath, ".gitignore"), "/outputs/\n");
				writeFileSync(join(repoPath, "selected.txt"), "selected change\n");
				writeFileSync(join(repoPath, "unselected.txt"), "staged change\n");
				runGit(repoPath, ["add", "unselected.txt"]);
				writeFileSync(join(repoPath, "unselected.txt"), "unstaged change\n");

				const result = await commitSelectedFiles({
					cwd: repoPath,
					paths: [deletedPath, ".gitignore", "selected.txt"],
					message: "remove generated file",
				});

				expect(result.ok, result.error).toBe(true);
				expect(runGit(repoPath, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe(
					".gitignore\nselected.txt\nunselected.txt",
				);
				expect(runGit(repoPath, ["show", "HEAD:selected.txt"])).toBe("selected change");
				expect(runGit(repoPath, ["show", "HEAD:unselected.txt"])).toBe("original");
				expect(runGit(repoPath, ["show", ":unselected.txt"])).toBe("staged change");
				expect(readFileSync(join(repoPath, "unselected.txt"), "utf8")).toBe("unstaged change\n");
				if (retainParent)
					expect(readFileSync(join(repoPath, "outputs", "private.txt"), "utf8")).toBe("ignored content\n");
				expect(gitStatus(repoPath)).toBe("MM unselected.txt");
			} finally {
				cleanup();
			}
		},
	);

	it("does not restore a staged ignored addition deleted from the worktree", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-deleted-addition-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "base.txt"), "base\n");
			commitAll(repoPath, "initial");
			mkdirSync(join(repoPath, "outputs"));
			writeFileSync(join(repoPath, "outputs", "generated.txt"), "staged addition\n");
			runGit(repoPath, ["add", "outputs/generated.txt"]);
			unlinkSync(join(repoPath, "outputs", "generated.txt"));
			writeFileSync(join(repoPath, "outputs", "private.txt"), "ignored content\n");
			writeFileSync(join(repoPath, ".gitignore"), "/outputs/\n");

			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: ["outputs/generated.txt", ".gitignore"],
				message: "ignore generated outputs",
			});

			expect(result.ok, result.error).toBe(true);
			expect(runGit(repoPath, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe(".gitignore\nbase.txt");
			expect(runGit(repoPath, ["ls-files"])).toBe(".gitignore\nbase.txt");
			expect(readFileSync(join(repoPath, "outputs", "private.txt"), "utf8")).toBe("ignored content\n");
			expect(gitStatus(repoPath)).toBe("");
		} finally {
			cleanup();
		}
	});

	it("supports an initial commit and treats selected filenames literally", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-initial-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "[draft].txt"), "selected\n");
			writeFileSync(join(repoPath, "d.txt"), "unselected\n");
			runGit(repoPath, ["add", "d.txt"]);
			const result = await commitSelectedFiles({ cwd: repoPath, paths: ["[draft].txt"], message: "initial" });
			expect(result.ok, result.error).toBe(true);
			expect(runGit(repoPath, ["ls-tree", "--name-only", "HEAD"])).toBe("[draft].txt");
			expect(gitStatus(repoPath)).toBe("A  d.txt");
		} finally {
			cleanup();
		}
	});

	it.each(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])(
		"rejects partial commits during %s",
		async (stateFile) => {
			const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-in-progress-");
			try {
				initRepository(repoPath);
				writeFileSync(join(repoPath, "file.txt"), "original\n");
				const head = commitAllAndReadHead(repoPath, "initial");
				writeFileSync(join(repoPath, ".git", stateFile), `${head}\n`);
				writeFileSync(join(repoPath, "file.txt"), "modified\n");
				const before = runGit(repoPath, ["write-tree"]);
				const result = await commitSelectedFiles({ cwd: repoPath, paths: ["file.txt"], message: "partial" });
				expect(result.ok).toBe(false);
				expect(result.error).toContain("Cannot commit selected files during");
				expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(head);
				expect(runGit(repoPath, ["write-tree"])).toBe(before);
			} finally {
				cleanup();
			}
		},
	);

	it.each([false, true])("preserves staged deletions (retained and ignored: %s)", async (retainLocally) => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-deletion-");
		try {
			initRepository(repoPath);
			const deletedPath = "~$Belgium Study Options - Dark Mode.xlsx";
			writeFileSync(join(repoPath, deletedPath), "generated file\n");
			writeFileSync(join(repoPath, "selected.txt"), "original\n");
			writeFileSync(join(repoPath, "unselected.txt"), "original\n");
			commitAll(repoPath, "initial");
			runGit(repoPath, ["rm", "--cached", "--", deletedPath]);
			if (!retainLocally) unlinkSync(join(repoPath, deletedPath));
			writeFileSync(join(repoPath, ".gitignore"), "~$*\n");
			writeFileSync(join(repoPath, "selected.txt"), "selected change\n");
			writeFileSync(join(repoPath, "unselected.txt"), "staged change\n");
			runGit(repoPath, ["add", "unselected.txt"]);
			writeFileSync(join(repoPath, "unselected.txt"), "unstaged change\n");
			const indexBefore = runGit(repoPath, ["show", ":unselected.txt"]);

			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: [deletedPath, ".gitignore", "selected.txt"],
				message: "remove generated file",
			});

			expect(result.ok, result.error).toBe(true);
			expect(runGit(repoPath, ["ls-tree", "--name-only", "HEAD"])).not.toContain(deletedPath);
			expect(runGit(repoPath, ["show", "HEAD:selected.txt"])).toBe("selected change");
			expect(runGit(repoPath, ["show", "HEAD:unselected.txt"])).toBe("original");
			expect(runGit(repoPath, ["show", ":unselected.txt"])).toBe(indexBefore);
			expect(readFileSync(join(repoPath, "unselected.txt"), "utf8")).toBe("unstaged change\n");
			expect(existsSync(join(repoPath, deletedPath))).toBe(retainLocally);
			if (retainLocally) expect(readFileSync(join(repoPath, deletedPath), "utf8")).toBe("generated file\n");
			expect(gitStatus(repoPath)).toBe("MM unselected.txt");
		} finally {
			cleanup();
		}
	});

	it("preserves the existing index when a commit fails", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-git-commit-preserve-index-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "deleted.txt"), "original\n");
			writeFileSync(join(repoPath, "modified.txt"), "original\n");
			commitAll(repoPath, "initial");
			runGit(repoPath, ["rm", "deleted.txt"]);
			writeFileSync(join(repoPath, "modified.txt"), "staged\n");
			runGit(repoPath, ["add", "modified.txt"]);
			writeFileSync(join(repoPath, "modified.txt"), "unstaged\n");
			const before = runGit(repoPath, ["write-tree"]);
			const headBefore = runGit(repoPath, ["rev-parse", "HEAD"]);
			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: ["deleted.txt", "modified.txt"],
				message: "",
			});
			expect(result.ok).toBe(false);
			expect(runGit(repoPath, ["write-tree"])).toBe(before);
			expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(headBefore);
			expect(readFileSync(join(repoPath, "modified.txt"), "utf8")).toBe("unstaged\n");
		} finally {
			cleanup();
		}
	});

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

			writeFileSync(join(repoPath, "file.txt"), "staged change\n");
			runGit(repoPath, ["add", "file.txt"]);
			const head = runGit(repoPath, ["rev-parse", "HEAD"]);
			const result = await commitSelectedFiles({
				cwd: repoPath,
				paths: [],
				message: "should fail",
			});

			expect(result.ok).toBe(false);
			expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(head);
			expect(gitStatus(repoPath)).toBe("M  file.txt");
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

describe("discardSingleFile", { concurrent: false }, () => {
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
