import type {
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitResponse,
	RuntimeGitCreateBranchResponse,
	RuntimeGitDeleteBranchResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeGitSyncSummary,
} from "../core/api-contract";
import { getGitSyncSummary } from "./git-probe";
import { hasGitRef, resolveRepoRoot, runGit, validateGitPath, validateGitRef } from "./git-utils";

export async function runGitSyncAction(options: {
	cwd: string;
	action: RuntimeGitSyncAction;
}): Promise<RuntimeGitSyncResponse> {
	const initialSummary = await getGitSyncSummary(options.cwd);

	if (options.action === "pull" && initialSummary.changedFiles > 0) {
		return {
			ok: false,
			action: options.action,
			summary: initialSummary,
			output: "",
			error: "Pull failed: working tree has local changes. Commit, stash, or discard changes first.",
			dirtyTree: true,
		};
	}

	const argsByAction: Record<RuntimeGitSyncAction, string[]> = {
		fetch: ["fetch", "--all", "--prune"],
		pull: ["pull", "--ff-only"],
		push: ["push"],
	};
	const commandResult = await runGit(options.cwd, argsByAction[options.action]);
	const nextSummary = await getGitSyncSummary(options.cwd);

	if (!commandResult.ok) {
		return {
			ok: false,
			action: options.action,
			summary: nextSummary,
			output: commandResult.output,
			error: commandResult.error ?? "Git command failed.",
		};
	}

	return {
		ok: true,
		action: options.action,
		summary: nextSummary,
		output: commandResult.output,
	};
}

export async function runGitCheckoutAction(options: {
	cwd: string;
	branch: string;
}): Promise<RuntimeGitCheckoutResponse> {
	const requestedBranch = options.branch.trim();
	const initialSummary = await getGitSyncSummary(options.cwd);

	if (!requestedBranch) {
		return {
			ok: false,
			branch: requestedBranch,
			summary: initialSummary,
			output: "",
			error: "Branch name cannot be empty.",
		};
	}

	if (initialSummary.currentBranch === requestedBranch) {
		return {
			ok: true,
			branch: requestedBranch,
			summary: initialSummary,
			output: `Already on '${requestedBranch}'.`,
		};
	}

	const repoRoot = await resolveRepoRoot(options.cwd);

	const hasLocalBranch = await hasGitRef(repoRoot, `refs/heads/${requestedBranch}`);
	const commandResult = hasLocalBranch
		? await runGit(repoRoot, ["switch", requestedBranch])
		: (await hasGitRef(repoRoot, `refs/remotes/origin/${requestedBranch}`))
			? await runGit(repoRoot, ["switch", "--track", `origin/${requestedBranch}`])
			: await runGit(repoRoot, ["switch", requestedBranch]);
	const nextSummary = await getGitSyncSummary(repoRoot);

	if (!commandResult.ok) {
		const dirtyTreePattern = /(?:local changes|uncommitted changes|overwritten by checkout)/i;
		const dirtyTree = dirtyTreePattern.test(commandResult.stderr) || undefined;
		return {
			ok: false,
			branch: requestedBranch,
			summary: nextSummary,
			output: commandResult.output,
			error: commandResult.error ?? "Git branch switch failed.",
			dirtyTree,
		};
	}

	return {
		ok: true,
		branch: requestedBranch,
		summary: nextSummary,
		output: commandResult.output,
	};
}

export async function createBranchFromRef(options: {
	cwd: string;
	branchName: string;
	startRef: string;
}): Promise<RuntimeGitCreateBranchResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const branchName = options.branchName.trim();
	const startRef = options.startRef.trim();

	if (!branchName) {
		return { ok: false, branchName, error: "Branch name cannot be empty." };
	}
	if (!startRef) {
		return { ok: false, branchName, error: "Start ref cannot be empty." };
	}

	// Check the start ref actually exists
	const verifyResult = await runGit(repoRoot, ["rev-parse", "--verify", startRef]);
	if (!verifyResult.ok) {
		return { ok: false, branchName, error: `Ref "${startRef}" does not exist.` };
	}

	// Check the branch doesn't already exist
	const existsResult = await hasGitRef(repoRoot, `refs/heads/${branchName}`);
	if (existsResult) {
		return { ok: false, branchName, error: `Branch "${branchName}" already exists.` };
	}

	const createResult = await runGit(repoRoot, ["branch", "--", branchName, startRef]);
	if (!createResult.ok) {
		return {
			ok: false,
			branchName,
			error: createResult.error ?? "Failed to create branch.",
		};
	}

	return { ok: true, branchName };
}

export async function deleteBranch(options: {
	cwd: string;
	branchName: string;
}): Promise<RuntimeGitDeleteBranchResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const branchName = options.branchName.trim();

	if (!branchName || !validateGitRef(branchName)) {
		return { ok: false, branchName, error: "Invalid branch name." };
	}

	// Verify the branch exists
	const exists = await hasGitRef(repoRoot, `refs/heads/${branchName}`);
	if (!exists) {
		return { ok: false, branchName, error: `Branch "${branchName}" does not exist locally.` };
	}

	// Refuse to delete the currently checked-out branch
	const headResult = await runGit(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
	if (headResult.ok && headResult.stdout === branchName) {
		return { ok: false, branchName, error: `Cannot delete the currently checked-out branch "${branchName}".` };
	}

	// Use -d (safe delete — requires branch to be fully merged).
	// If the branch is unmerged, git will error with a helpful message.
	const deleteResult = await runGit(repoRoot, ["branch", "-d", "--", branchName]);
	if (!deleteResult.ok) {
		return {
			ok: false,
			branchName,
			error: deleteResult.error ?? "Failed to delete branch.",
		};
	}

	return { ok: true, branchName };
}

export async function discardGitChanges(options: { cwd: string }): Promise<RuntimeGitDiscardResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const initialSummary = await getGitSyncSummary(repoRoot);

	if (initialSummary.changedFiles === 0) {
		return {
			ok: true,
			summary: initialSummary,
			output: "Working tree is already clean.",
		};
	}

	const restoreResult = await runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."]);
	const cleanResult = restoreResult.ok ? await runGit(repoRoot, ["clean", "-fd", "--", "."]) : null;
	const nextSummary = await getGitSyncSummary(repoRoot);
	const output = [restoreResult.output, cleanResult?.output ?? ""].filter(Boolean).join("\n");

	if (!restoreResult.ok) {
		return {
			ok: false,
			summary: nextSummary,
			output,
			error: restoreResult.error ?? "Discard failed.",
		};
	}

	if (cleanResult && !cleanResult.ok) {
		return {
			ok: false,
			summary: nextSummary,
			output,
			error: cleanResult.error ?? "Discard failed while cleaning untracked files.",
		};
	}

	return {
		ok: true,
		summary: nextSummary,
		output,
	};
}

function createEmptySummary(): RuntimeGitSyncSummary {
	return {
		currentBranch: null,
		upstreamBranch: null,
		changedFiles: 0,
		additions: 0,
		deletions: 0,
		aheadCount: 0,
		behindCount: 0,
	};
}

export async function commitSelectedFiles(options: {
	cwd: string;
	paths: string[];
	message: string;
}): Promise<RuntimeGitCommitResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);

	// Validate all paths before any git operations.
	for (const p of options.paths) {
		if (!validateGitPath(p)) {
			return {
				ok: false,
				summary: createEmptySummary(),
				output: "",
				error: `Invalid file path: ${p}`,
			};
		}
	}

	// Stage the specified files.
	const addResult = await runGit(repoRoot, ["add", "--", ...options.paths]);
	if (!addResult.ok) {
		return {
			ok: false,
			summary: await getGitSyncSummary(repoRoot),
			output: addResult.output,
			error: addResult.error ?? "Failed to stage files.",
		};
	}

	// Commit only the staged paths (avoids committing pre-staged files the user didn't select).
	const commitResult = await runGit(repoRoot, ["commit", "-m", options.message, "--", ...options.paths]);
	if (!commitResult.ok) {
		// Rollback staging if commit failed.
		await runGit(repoRoot, ["reset", "HEAD", "--", ...options.paths]);
		return {
			ok: false,
			summary: await getGitSyncSummary(repoRoot),
			output: commitResult.output,
			error: commitResult.error ?? "Commit failed.",
		};
	}

	// Extract commit hash from output (format: "[branch hash] message").
	const hashMatch = commitResult.stdout.match(/\[[\w/.-]+ ([0-9a-f]+)\]/);
	const commitHash = hashMatch?.[1];

	const nextSummary = await getGitSyncSummary(repoRoot);

	return {
		ok: true,
		commitHash,
		summary: nextSummary,
		output: commitResult.output,
	};
}

export async function discardSingleFile(options: {
	cwd: string;
	path: string;
	fileStatus: string;
}): Promise<RuntimeGitDiscardResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);

	if (!validateGitPath(options.path)) {
		return {
			ok: false,
			summary: createEmptySummary(),
			output: "",
			error: "Invalid file path.",
		};
	}

	// Renamed/copied files cannot be rolled back individually.
	if (options.fileStatus === "renamed" || options.fileStatus === "copied") {
		return {
			ok: false,
			summary: await getGitSyncSummary(repoRoot),
			output: "",
			error: "Cannot rollback renamed/copied files individually. Use Discard All instead.",
		};
	}

	// New staged files ("added") don't exist at HEAD — unstage before cleaning.
	if (options.fileStatus === "added") {
		await runGit(repoRoot, ["rm", "--cached", "--force", "--", options.path]);
	}

	const result =
		options.fileStatus === "untracked" || options.fileStatus === "added"
			? await runGit(repoRoot, ["clean", "-f", "--", options.path])
			: await runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", options.path]);

	const nextSummary = await getGitSyncSummary(repoRoot);

	if (!result.ok) {
		return {
			ok: false,
			summary: nextSummary,
			output: result.output,
			error: result.error ?? "Failed to discard file changes.",
		};
	}

	return {
		ok: true,
		summary: nextSummary,
		output: result.output,
	};
}
