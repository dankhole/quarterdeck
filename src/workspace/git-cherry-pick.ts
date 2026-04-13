import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeGitCherryPickResponse } from "../core/api-contract";
import { hasGitRef, resolveRepoRoot, runGit, validateGitRef } from "./git-utils";

/**
 * Parse `git worktree list --porcelain` output to find which directory
 * has a given branch checked out. Returns null if the branch is not
 * checked out in any worktree.
 */
function findWorktreeForBranch(porcelainOutput: string, branchName: string): string | null {
	const branchRef = `branch refs/heads/${branchName}`;
	let currentWorktree: string | null = null;
	for (const line of porcelainOutput.split("\n")) {
		if (line.startsWith("worktree ")) {
			currentWorktree = line.slice("worktree ".length);
		} else if (line === branchRef && currentWorktree) {
			return currentWorktree;
		}
	}
	return null;
}

export async function cherryPickCommit(options: {
	cwd: string;
	commitHash: string;
	targetBranch: string;
}): Promise<RuntimeGitCherryPickResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const commitHash = options.commitHash.trim();
	const targetBranch = options.targetBranch.trim();

	const errorResponse = (error: string): RuntimeGitCherryPickResponse => ({
		ok: false,
		commitHash,
		targetBranch,
		output: "",
		error,
	});

	if (!commitHash || !targetBranch) {
		return errorResponse("Commit hash and target branch are required.");
	}
	if (!validateGitRef(targetBranch)) {
		return errorResponse("Invalid target branch name.");
	}

	// Validate commit exists
	const verifyResult = await runGit(repoRoot, ["rev-parse", "--verify", `${commitHash}^{commit}`]);
	if (!verifyResult.ok) {
		return errorResponse(`Commit ${commitHash} does not exist.`);
	}

	// Reject merge commits (multiple parents)
	const parentResult = await runGit(repoRoot, ["rev-list", "--parents", "-n", "1", commitHash]);
	if (!parentResult.ok) {
		return errorResponse("Could not read commit parents.");
	}
	const parentParts = parentResult.stdout.split(/\s+/);
	if (parentParts.length > 2) {
		return errorResponse("Cannot cherry-pick merge commits. Select individual commits instead.");
	}

	// Validate target branch exists
	const branchExists = await hasGitRef(repoRoot, `refs/heads/${targetBranch}`);
	if (!branchExists) {
		return errorResponse(`Branch "${targetBranch}" does not exist.`);
	}

	// Find where the target branch is checked out (if anywhere)
	const worktreeListResult = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	const checkedOutPath = worktreeListResult.ok ? findWorktreeForBranch(worktreeListResult.stdout, targetBranch) : null;

	if (checkedOutPath) {
		return await cherryPickInDirectory(checkedOutPath, commitHash, targetBranch);
	}

	return await cherryPickViaTempWorktree(repoRoot, commitHash, targetBranch);
}

async function cherryPickInDirectory(
	targetDir: string,
	commitHash: string,
	targetBranch: string,
): Promise<RuntimeGitCherryPickResponse> {
	// Check for uncommitted changes in the target directory
	const statusResult = await runGit(targetDir, ["status", "--porcelain"]);
	if (statusResult.ok && statusResult.stdout.trim()) {
		return {
			ok: false,
			commitHash,
			targetBranch,
			output: "",
			error: `Branch "${targetBranch}" has uncommitted changes (checked out at ${targetDir}). Commit or discard them first.`,
		};
	}

	const pickResult = await runGit(targetDir, ["cherry-pick", "--no-edit", commitHash]);
	if (!pickResult.ok) {
		// Abort to restore clean state
		await runGit(targetDir, ["cherry-pick", "--abort"]);
		return {
			ok: false,
			commitHash,
			targetBranch,
			output: pickResult.output,
			error: `Cherry-pick failed (conflicts). Aborted — no changes were made to ${targetBranch}.`,
		};
	}

	// Read the new commit hash
	const newHeadResult = await runGit(targetDir, ["rev-parse", "HEAD"]);
	const newCommitHash = newHeadResult.ok ? newHeadResult.stdout : undefined;

	return {
		ok: true,
		commitHash,
		targetBranch,
		newCommitHash,
		output: pickResult.output,
	};
}

async function cherryPickViaTempWorktree(
	repoRoot: string,
	commitHash: string,
	targetBranch: string,
): Promise<RuntimeGitCherryPickResponse> {
	const tempPath = join(tmpdir(), `qd-cherry-pick-${randomUUID()}`);

	// Create a temp worktree checked out to the target branch
	const addResult = await runGit(repoRoot, ["worktree", "add", tempPath, targetBranch]);
	if (!addResult.ok) {
		return {
			ok: false,
			commitHash,
			targetBranch,
			output: addResult.output,
			error: `Could not create temporary worktree for "${targetBranch}": ${addResult.error ?? "unknown error"}`,
		};
	}

	try {
		const pickResult = await runGit(tempPath, ["cherry-pick", "--no-edit", commitHash]);
		if (!pickResult.ok) {
			await runGit(tempPath, ["cherry-pick", "--abort"]);
			return {
				ok: false,
				commitHash,
				targetBranch,
				output: pickResult.output,
				error: `Cherry-pick failed (conflicts). Aborted — no changes were made to ${targetBranch}.`,
			};
		}

		const newHeadResult = await runGit(tempPath, ["rev-parse", "HEAD"]);
		const newCommitHash = newHeadResult.ok ? newHeadResult.stdout : undefined;

		return {
			ok: true,
			commitHash,
			targetBranch,
			newCommitHash,
			output: pickResult.output,
		};
	} finally {
		// Always clean up the temp worktree
		await runGit(repoRoot, ["worktree", "remove", "--force", tempPath]);
	}
}
