import type {
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitResponse,
	RuntimeGitCreateBranchResponse,
	RuntimeGitDeleteBranchResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitRenameBranchResponse,
	RuntimeGitResetToRefResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeGitSyncSummary,
} from "../core";
import { getGitSyncSummary } from "./git-probe";
import { hasGitRef, resolveRepoRoot, runGit, validateGitPath, validateGitRef } from "./git-utils";

export async function runGitSyncAction(options: {
	cwd: string;
	action: RuntimeGitSyncAction;
	/** When set, targets a specific branch instead of the currently checked-out one. */
	branch?: string | null;
}): Promise<RuntimeGitSyncResponse> {
	const targetBranch = options.branch?.trim() || null;

	// The initial summary is only needed when:
	// - pull: dirty-tree guard checks changedFiles
	// - explicit branch: isOtherBranch determines push target / fetch strategy
	// For push/fetch without a target branch, skip the expensive probe.
	const needsInitialProbe = options.action === "pull" || targetBranch !== null;
	const initialSummary = needsInitialProbe ? await getGitSyncSummary(options.cwd) : null;
	const isOtherBranch = targetBranch !== null && targetBranch !== initialSummary?.currentBranch;

	if (options.action === "pull" && !isOtherBranch && initialSummary && initialSummary.changedFiles > 0) {
		return {
			ok: false,
			action: options.action,
			summary: initialSummary,
			output: "",
			error: "Pull failed: working tree has local changes. Commit, stash, or discard changes first.",
			dirtyTree: true,
		};
	}

	let gitArgs: string[];
	if (isOtherBranch) {
		if (options.action === "pull") {
			// Fast-forward update a non-checked-out local branch from its remote tracking branch.
			gitArgs = ["fetch", "origin", `${targetBranch}:${targetBranch}`];
		} else if (options.action === "push") {
			gitArgs = ["push", "origin", targetBranch];
		} else {
			// fetch: no branch-specific behaviour needed
			gitArgs = ["fetch", "--all", "--prune"];
		}
	} else {
		const argsByAction: Record<RuntimeGitSyncAction, string[]> = {
			fetch: ["fetch", "--all", "--prune"],
			pull: ["pull", "--ff-only"],
			push: ["push"],
		};
		gitArgs = argsByAction[options.action];
	}

	const commandResult = await runGit(options.cwd, gitArgs);
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

export async function renameBranch(options: {
	cwd: string;
	oldName: string;
	newName: string;
}): Promise<RuntimeGitRenameBranchResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const oldName = options.oldName.trim();
	const newName = options.newName.trim();

	if (!oldName || !validateGitRef(oldName)) {
		return { ok: false, oldName, newName, error: "Invalid current branch name." };
	}
	if (!newName || !validateGitRef(newName)) {
		return { ok: false, oldName, newName, error: "Invalid new branch name." };
	}

	const exists = await hasGitRef(repoRoot, `refs/heads/${oldName}`);
	if (!exists) {
		return { ok: false, oldName, newName, error: `Branch "${oldName}" does not exist locally.` };
	}

	const targetExists = await hasGitRef(repoRoot, `refs/heads/${newName}`);
	if (targetExists) {
		return { ok: false, oldName, newName, error: `Branch "${newName}" already exists.` };
	}

	const renameResult = await runGit(repoRoot, ["branch", "-m", oldName, newName]);
	if (!renameResult.ok) {
		return {
			ok: false,
			oldName,
			newName,
			error: renameResult.error ?? "Failed to rename branch.",
		};
	}

	return { ok: true, oldName, newName };
}

export async function resetToRef(options: { cwd: string; ref: string }): Promise<RuntimeGitResetToRefResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const targetRef = options.ref.trim();

	if (!targetRef || !validateGitRef(targetRef)) {
		const summary = await getGitSyncSummary(repoRoot);
		return { ok: false, ref: targetRef, summary, output: "", error: "Invalid ref." };
	}

	const verifyResult = await runGit(repoRoot, ["rev-parse", "--verify", targetRef]);
	if (!verifyResult.ok) {
		const summary = await getGitSyncSummary(repoRoot);
		return { ok: false, ref: targetRef, summary, output: "", error: `Ref "${targetRef}" does not exist.` };
	}

	const resetResult = await runGit(repoRoot, ["reset", "--hard", targetRef]);
	const summary = await getGitSyncSummary(repoRoot);

	if (!resetResult.ok) {
		return {
			ok: false,
			ref: targetRef,
			summary,
			output: resetResult.output,
			error: resetResult.error ?? "Reset failed.",
		};
	}

	return { ok: true, ref: targetRef, summary, output: resetResult.output };
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
