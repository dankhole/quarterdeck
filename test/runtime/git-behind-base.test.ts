import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTaskWorktreeMetadata } from "../../src/server/project-metadata-loaders";
import { getCommitsBehindBase } from "../../src/workdir";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

describe("behind-base commit counts", () => {
	let repo: ReturnType<typeof createTempDir>;
	let seed: string;
	let tree: string;

	beforeEach(() => {
		repo = createTempDir("quarterdeck-behind-base-");
		initGitRepository(repo.path);
		writeFileSync(join(repo.path, "README.md"), "seed\n");
		seed = commitAll(repo.path, "seed");
		tree = runGit(repo.path, ["rev-parse", "HEAD^{tree}"]);
	});

	afterEach(() => repo.cleanup());

	function commit(message: string, ...parents: string[]): string {
		return runGit(repo.path, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message]);
	}

	function setRef(ref: string, sha: string): void {
		runGit(repo.path, ["update-ref", ref, sha]);
	}

	it("excludes shared history when both branches merge each other's ancestors", async () => {
		const left = commit("left", commit("left ancestor", seed));
		const right = commit("right", commit("right ancestor", seed));
		const base = commit("base merge", left, right);
		const task = commit("task merge", right, left);
		setRef("refs/remotes/origin/main", base);
		setRef("HEAD", task);

		const mergeBase = runGit(repo.path, ["merge-base", "HEAD", base]);
		expect(Number(runGit(repo.path, ["rev-list", "--count", `${mergeBase}..${base}`]))).toBeGreaterThan(1);
		expect(await getCommitsBehindBase(repo.path, "main")).toMatchObject({ behindCount: 1 });
	});

	it("prefers the remote base even when a divergent local base has missing commits", async () => {
		setRef("refs/heads/base", commit("local only", seed));
		setRef("refs/remotes/origin/base", seed);
		expect(await getCommitsBehindBase(repo.path, "base")).toMatchObject({ behindCount: 0 });
	});

	it("compares against a remote-only base", async () => {
		setRef("refs/remotes/origin/base", commit("remote advance", seed));
		expect(await getCommitsBehindBase(repo.path, "base")).toMatchObject({ behindCount: 1 });
	});

	it("falls back to a local base when no origin tracking ref exists", async () => {
		setRef("refs/heads/base", commit("local advance", seed));
		expect(await getCommitsBehindBase(repo.path, "base")).toMatchObject({ behindCount: 1 });
	});

	it("honors explicit local and remote refs", async () => {
		setRef("refs/heads/base", commit("local advance", seed));
		setRef("refs/remotes/origin/base", seed);
		// A branch named origin/base must not shadow the explicit remote comparison.
		setRef("refs/remotes/origin/origin/base", commit("different remote branch", seed));
		expect(await getCommitsBehindBase(repo.path, "refs/heads/base")).toMatchObject({ behindCount: 1 });
		expect(await getCommitsBehindBase(repo.path, "origin/base")).toMatchObject({ behindCount: 0 });
		expect(await getCommitsBehindBase(repo.path, "refs/remotes/origin/base")).toMatchObject({ behindCount: 0 });
	});

	it("returns unknown for missing or invalid refs", async () => {
		for (const ref of ["missing", "", "--all", "main..HEAD"]) {
			expect(await getCommitsBehindBase(repo.path, ref)).toBeNull();
		}
	});

	it("refreshes projected counts when the remote ref appears or advances without HEAD changing", async () => {
		setRef("refs/heads/base", commit("local advance", seed));
		const task = { taskId: "task-1", baseRef: "base", workingDirectory: null, useWorktree: false };
		const local = await loadTaskWorktreeMetadata(repo.path, task, null);
		expect(local?.data.behindBaseCount).toBe(1);
		setRef("refs/remotes/origin/base", seed);
		const remote = await loadTaskWorktreeMetadata(repo.path, task, local);
		expect(remote?.data.behindBaseCount).toBe(0);
		setRef("refs/remotes/origin/base", commit("remote advance", seed));
		const advanced = await loadTaskWorktreeMetadata(repo.path, task, remote);
		expect(advanced?.data.behindBaseCount).toBe(1);
	});
});
