import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	abortMergeOrRebase,
	continueMergeOrRebase,
	getConflictState,
	resolveConflictFile,
} from "../../src/workdir/git-conflict";
import { revertCommit } from "../../src/workdir/git-revert";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

describe("revertCommit with a real synthetic repository", () => {
	let temp: ReturnType<typeof createTempDir>;
	let original: string;
	let changed: string;
	function git(...args: string[]): string {
		const result = spawnSync("git", args, { cwd: temp.path, encoding: "utf8", env: createGitTestEnv() });
		if (result.status !== 0) throw new Error(result.stderr || result.stdout);
		return result.stdout.trim();
	}
	function commit(content: string): string {
		writeFileSync(join(temp.path, "file.txt"), content);
		git("add", "file.txt");
		git("commit", "-qm", content.trim());
		return git("rev-parse", "HEAD");
	}
	function revert(commitHash = changed, expectedHead = git("rev-parse", "HEAD"), cwd = temp.path) {
		return revertCommit({ cwd, commitHash, expectedHead, expectedBranch: "main" });
	}
	beforeEach(() => {
		temp = createTempDir("qd-revert-");
		git("init", "-q", "-b", "main");
		git("config", "core.autocrlf", "false");
		git("config", "user.name", "Test User");
		git("config", "user.email", "test@example.com");
		original = commit("original\n");
		changed = commit("changed\n");
	});
	afterEach(() => temp.cleanup());
	it("adds an inverse commit and preserves the original ancestry", async () => {
		expect((await revert()).ok).toBe(true);
		expect(readFileSync(join(temp.path, "file.txt"), "utf8")).toBe("original\n");
		expect(git("rev-parse", "HEAD^")).toBe(changed);
		expect(git("rev-parse", "HEAD^^")).toBe(original);
		expect(await getConflictState(temp.path)).toBeNull();
	});
	it("supports reverting a root commit with the same singleton range", async () => {
		git("checkout", "-qb", "root-only", original);
		const result = await revertCommit({
			cwd: temp.path,
			commitHash: original,
			expectedHead: original,
			expectedBranch: "root-only",
		});
		expect(result.ok).toBe(true);
		expect(git("rev-parse", "HEAD^")).toBe(original);
		expect(existsSync(join(temp.path, "file.txt"))).toBe(false);
	});
	it("refuses changed HEAD, dirty trees, and invalid option-like revisions", async () => {
		expect((await revert(changed, original)).error).toContain("changed");
		writeFileSync(join(temp.path, "untracked.txt"), "keep me");
		expect((await revert()).error).toContain("Commit or stash");
		expect((await revert("--all")).error).toContain("Invalid commit hash");
		expect(git("rev-parse", "HEAD")).toBe(changed);
	});
	it("rejects a different branch at the same HEAD and detached HEAD", async () => {
		git("checkout", "-qb", "same-head");
		expect((await revert()).error).toContain("branch changed");
		git("checkout", "--detach", changed);
		expect((await revert()).error).toContain("Check out a branch");
		expect(git("rev-parse", "HEAD")).toBe(changed);
	});
	it("leaves conflicts available to resolve and continue", async () => {
		const later = commit("later\n");
		const result = await revert();
		expect(result.ok).toBe(false);
		expect(result.conflictState).toMatchObject({ operation: "revert", conflictedFiles: ["file.txt"] });
		expect((await revert()).error).toContain("current Git operation");
		expect((await resolveConflictFile(temp.path, "file.txt", "theirs")).ok).toBe(true);
		expect(await continueMergeOrRebase(temp.path)).toMatchObject({ ok: true, completed: true });
		expect(git("rev-parse", "HEAD^")).toBe(later);
		expect(readFileSync(join(temp.path, "file.txt"), "utf8")).toBe("original\n");
		expect(await getConflictState(temp.path)).toBeNull();
	});
	it("aborts a conflicted revert without changing history", async () => {
		const later = commit("later\n");
		await revert();
		expect((await abortMergeOrRebase(temp.path)).ok).toBe(true);
		expect(git("rev-parse", "HEAD")).toBe(later);
		expect(readFileSync(join(temp.path, "file.txt"), "utf8")).toBe("later\n");
		expect(git("status", "--porcelain")).toBe("");
	});
	it("rejects merge commits without guessing a mainline", async () => {
		git("checkout", "-qb", "other", original);
		writeFileSync(join(temp.path, "other.txt"), "other\n");
		git("add", ".");
		git("commit", "-qm", "other");
		git("checkout", "main");
		git("merge", "--no-ff", "--no-edit", "other");
		const merged = git("rev-parse", "HEAD");
		expect((await revert(merged)).error).toContain("mainline");
		expect(git("rev-parse", "HEAD")).toBe(merged);
	});
	it("does not report success when the commit hook fails and allows abort", async () => {
		const hooks = join(temp.path, ".git", "test-hooks");
		mkdirSync(hooks);
		writeFileSync(join(hooks, "prepare-commit-msg"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		git("config", "core.hooksPath", hooks);
		const result = await revert();
		expect(result.ok).toBe(false);
		expect(result.conflictState?.operation).toBe("revert");
		expect(result.error).toBeTruthy();
		expect((await continueMergeOrRebase(temp.path)).ok).toBe(false);
		expect((await abortMergeOrRebase(temp.path)).ok).toBe(true);
		expect(git("rev-parse", "HEAD")).toBe(changed);
		expect(readFileSync(join(temp.path, "file.txt"), "utf8")).toBe("changed\n");
	});
	it("continues a revert after a failed commit hook is fixed", async () => {
		const hook = join(temp.path, ".git", "hooks", "prepare-commit-msg");
		git("config", "core.hooksPath", join(temp.path, ".git", "hooks"));
		writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		expect((await revert()).ok).toBe(false);
		unlinkSync(hook);
		expect(await continueMergeOrRebase(temp.path)).toMatchObject({ ok: true, completed: true });
		expect(git("rev-parse", "HEAD^")).toBe(changed);
		expect(await getConflictState(temp.path)).toBeNull();
	});
	it("reports an already-reverted commit as incomplete without rewriting history", async () => {
		await revert();
		const reverted = git("rev-parse", "HEAD");
		const result = await revert();
		expect(result.ok).toBe(false);
		expect(git("rev-parse", "HEAD")).toBe(reverted);
		if (result.conflictState) expect((await abortMergeOrRebase(temp.path)).ok).toBe(true);
		expect(readFileSync(join(temp.path, "file.txt"), "utf8")).toBe("original\n");
	});

	it("detects and aborts revert state inside a linked worktree", async () => {
		const later = commit("later\n");
		git("checkout", "-qb", "other");
		const worktree = join(temp.path, "linked");
		git("worktree", "add", worktree, "main");
		expect((await revert(changed, later, worktree)).conflictState?.operation).toBe("revert");
		expect((await abortMergeOrRebase(worktree)).ok).toBe(true);
		expect(readFileSync(join(worktree, "file.txt"), "utf8")).toBe("later\n");
	});
});
