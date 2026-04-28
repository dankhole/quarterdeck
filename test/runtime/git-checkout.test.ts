import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { runGitCheckoutAction } from "../../src/workdir";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function setupRemoteClone(
	prefix: string,
	branchName: string,
): {
	sandboxRoot: string;
	localPath: string;
	cleanup: () => void;
} {
	const { path: sandboxRoot, cleanup } = createTempDir(prefix);
	const remotePath = join(sandboxRoot, "origin.git");
	const seedPath = join(sandboxRoot, "seed");
	const localPath = join(sandboxRoot, "local");

	mkdirSync(remotePath, { recursive: true });
	mkdirSync(seedPath, { recursive: true });
	runGit(remotePath, ["init", "--bare", "-q", "-b", "main"]);
	initGitRepository(seedPath);
	writeFileSync(join(seedPath, "file.txt"), "main\n", "utf8");
	commitAll(seedPath, "initial commit");
	runGit(seedPath, ["remote", "add", "origin", remotePath]);
	runGit(seedPath, ["push", "-u", "origin", "main"]);

	runGit(seedPath, ["switch", "-c", branchName]);
	writeFileSync(join(seedPath, "feature.txt"), `${branchName}\n`, "utf8");
	commitAll(seedPath, "remote branch commit");
	runGit(seedPath, ["push", "origin", branchName]);

	runGit(sandboxRoot, ["clone", "-q", remotePath, localPath]);
	return { sandboxRoot, localPath, cleanup };
}

function currentBranch(cwd: string): string {
	return runGit(cwd, ["branch", "--show-current"]);
}

function headCommit(cwd: string, ref = "HEAD"): string {
	return runGit(cwd, ["rev-parse", ref]);
}

function upstreamBranch(cwd: string, branch: string): string {
	return runGit(cwd, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
}

describe.sequential("runGitCheckoutAction", () => {
	it("tracks an explicit origin remote ref from the branch selector", async () => {
		const branchName = "feature/remote-only";
		const { localPath, cleanup } = setupRemoteClone("quarterdeck-git-checkout-remote-", branchName);
		try {
			expect(runGit(localPath, ["branch", "--list", branchName])).toBe("");

			const result = await runGitCheckoutAction({ cwd: localPath, branch: `origin/${branchName}` });

			expect(result.ok).toBe(true);
			expect(currentBranch(localPath)).toBe(branchName);
			expect(upstreamBranch(localPath, branchName)).toBe(`origin/${branchName}`);
		} finally {
			cleanup();
		}
	});

	it("tracks a full refs/remotes ref from the branch selector", async () => {
		const branchName = "feature/full-remote-ref";
		const { localPath, cleanup } = setupRemoteClone("quarterdeck-git-checkout-full-remote-", branchName);
		try {
			const result = await runGitCheckoutAction({ cwd: localPath, branch: `refs/remotes/origin/${branchName}` });

			expect(result.ok).toBe(true);
			expect(currentBranch(localPath)).toBe(branchName);
			expect(upstreamBranch(localPath, branchName)).toBe(`origin/${branchName}`);
		} finally {
			cleanup();
		}
	});

	it("rejects full remote refs whose normalized remote name is unsafe", async () => {
		const branchName = "feature/invalid-normalized-remote";
		const { localPath, cleanup } = setupRemoteClone("quarterdeck-git-checkout-invalid-normalized-", branchName);
		try {
			const result = await runGitCheckoutAction({ cwd: localPath, branch: "refs/remotes/-evil/feature" });

			expect(result.ok).toBe(false);
			expect(result.error).toBe("Invalid branch name.");
		} finally {
			cleanup();
		}
	});

	it("switches to the existing local branch for an explicit matching remote ref", async () => {
		const branchName = "feature/existing-local";
		const { localPath, cleanup } = setupRemoteClone("quarterdeck-git-checkout-local-for-remote-", branchName);
		try {
			runGit(localPath, ["switch", "--track", `origin/${branchName}`]);
			runGit(localPath, ["switch", "main"]);

			const result = await runGitCheckoutAction({ cwd: localPath, branch: `origin/${branchName}` });

			expect(result.ok).toBe(true);
			expect(currentBranch(localPath)).toBe(branchName);
			expect(upstreamBranch(localPath, branchName)).toBe(`origin/${branchName}`);
		} finally {
			cleanup();
		}
	});

	it("detaches an explicit remote ref when the matching local branch is checked out elsewhere", async () => {
		const branchName = "feature/worktree-locked-local";
		const { sandboxRoot, localPath, cleanup } = setupRemoteClone(
			"quarterdeck-git-checkout-locked-worktree-",
			branchName,
		);
		try {
			runGit(localPath, ["switch", "--track", `origin/${branchName}`]);
			const worktreePath = join(sandboxRoot, "linked-worktree");
			runGit(localPath, ["worktree", "add", "--detach", worktreePath, "main"]);
			const remoteCommit = headCommit(worktreePath, `origin/${branchName}`);

			const result = await runGitCheckoutAction({ cwd: worktreePath, branch: `origin/${branchName}` });

			expect(result.ok).toBe(true);
			expect(currentBranch(worktreePath)).toBe("");
			expect(headCommit(worktreePath)).toBe(remoteCommit);
			expect(result.summary.currentBranch).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("tracks an explicit remote ref from a linked worktree checkout", async () => {
		const branchName = "feature/worktree-remote";
		const { sandboxRoot, localPath, cleanup } = setupRemoteClone("quarterdeck-git-checkout-worktree-", branchName);
		try {
			const worktreePath = join(sandboxRoot, "linked-worktree");
			runGit(localPath, ["worktree", "add", "--detach", worktreePath, "main"]);

			const result = await runGitCheckoutAction({ cwd: worktreePath, branch: `origin/${branchName}` });

			expect(result.ok).toBe(true);
			expect(currentBranch(worktreePath)).toBe(branchName);
			expect(upstreamBranch(worktreePath, branchName)).toBe(`origin/${branchName}`);
		} finally {
			cleanup();
		}
	});
});
