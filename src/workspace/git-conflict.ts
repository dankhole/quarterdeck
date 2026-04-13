import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
	RuntimeAutoMergedFile,
	RuntimeConflictAbortResponse,
	RuntimeConflictContinueResponse,
	RuntimeConflictFile,
	RuntimeConflictState,
	RuntimeGitMergeResponse,
} from "../core/api-contract";
import { getGitSyncSummary } from "./git-probe";
import { resolveRepoRoot, runGit, validateGitPath, validateGitRef } from "./git-utils";

// ---------------------------------------------------------------------------
// Conflict detection / query functions
// ---------------------------------------------------------------------------

interface DetectedConflict {
	operation: "merge" | "rebase";
	sourceBranch: string | null;
	currentStep: number | null;
	totalSteps: number | null;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function readFileSafe(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Detect whether `cwd` is in an active merge or rebase conflict state.
 * Returns structured info about the conflict, or `null` if the repo is clean.
 */
export async function detectActiveConflict(cwd: string): Promise<DetectedConflict | null> {
	// Resolve the actual git directory — in worktrees, .git is a file, not a directory.
	const gitDirResult = await runGit(cwd, ["rev-parse", "--git-dir"]);
	if (!gitDirResult.ok || !gitDirResult.stdout) {
		return null;
	}
	const rawGitDir = gitDirResult.stdout.trim();
	// git rev-parse --git-dir may return a relative path; resolve against cwd.
	const gitDir = rawGitDir.startsWith("/") ? rawGitDir : join(cwd, rawGitDir);

	// Check for active merge
	if (await fileExists(join(gitDir, "MERGE_HEAD"))) {
		let sourceBranch: string | null = null;
		const mergeMsg = await readFileSafe(join(gitDir, "MERGE_MSG"));
		if (mergeMsg) {
			const match = mergeMsg.match(/^Merge branch '([^']+)'/);
			if (match) {
				sourceBranch = match[1] ?? null;
			}
		}
		return { operation: "merge", sourceBranch, currentStep: null, totalSteps: null };
	}

	// Check for active rebase
	const rebaseMergeDir = join(gitDir, "rebase-merge");
	if (await fileExists(rebaseMergeDir)) {
		let sourceBranch: string | null = null;
		let currentStep: number | null = null;
		let totalSteps: number | null = null;

		const headName = await readFileSafe(join(rebaseMergeDir, "head-name"));
		if (headName) {
			sourceBranch = headName.trim().replace(/^refs\/heads\//, "");
		}

		const msgnumRaw = await readFileSafe(join(rebaseMergeDir, "msgnum"));
		if (msgnumRaw) {
			const parsed = Number.parseInt(msgnumRaw.trim(), 10);
			if (Number.isFinite(parsed)) {
				currentStep = parsed;
			}
		}

		const endRaw = await readFileSafe(join(rebaseMergeDir, "end"));
		if (endRaw) {
			const parsed = Number.parseInt(endRaw.trim(), 10);
			if (Number.isFinite(parsed)) {
				totalSteps = parsed;
			}
		}

		return { operation: "rebase", sourceBranch, currentStep, totalSteps };
	}

	return null;
}

/**
 * List currently-unresolved conflicted file paths in the working tree.
 * Uses `git ls-files -u` and deduplicates across stage entries.
 */
export async function getConflictedFiles(cwd: string): Promise<string[]> {
	const result = await runGit(cwd, ["ls-files", "-u"]);
	if (!result.ok || !result.stdout) {
		return [];
	}

	const paths = new Set<string>();
	for (const rawLine of result.stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		// Format: <mode> <object> <stage>\t<path>
		const tabIndex = line.indexOf("\t");
		if (tabIndex === -1) {
			continue;
		}
		const filePath = line.slice(tabIndex + 1);
		if (filePath) {
			paths.add(filePath);
		}
	}

	return Array.from(paths).sort();
}

/**
 * Retrieve the "ours" (stage 2) and "theirs" (stage 3) content for a single conflicted file.
 * Returns empty strings for content if the corresponding stage doesn't exist.
 */
export async function getConflictFileContent(cwd: string, path: string): Promise<RuntimeConflictFile> {
	if (!validateGitPath(path)) {
		return { path, oursContent: "", theirsContent: "" };
	}
	const [oursResult, theirsResult] = await Promise.all([
		runGit(cwd, ["show", `:2:${path}`]),
		runGit(cwd, ["show", `:3:${path}`]),
	]);

	return {
		path,
		oursContent: oursResult.ok ? oursResult.stdout : "",
		theirsContent: theirsResult.ok ? theirsResult.stdout : "",
	};
}

/**
 * Compute the list of auto-merged files (staged by git but not conflicted).
 * These are files where git successfully merged changes from both sides.
 */
export async function computeAutoMergedFiles(cwd: string, conflictedFiles: string[]): Promise<string[]> {
	const cachedResult = await runGit(cwd, ["diff", "--cached", "--name-only"]);
	if (!cachedResult.ok || !cachedResult.stdout.trim()) {
		return [];
	}
	const conflictedSet = new Set(conflictedFiles);
	return cachedResult.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !conflictedSet.has(line))
		.sort();
}

/**
 * Get the before/after content of an auto-merged file.
 * `HEAD:<path>` gives the content before merge, `:0:<path>` (stage 0) gives the merged result.
 */
export async function getAutoMergedFileContent(cwd: string, path: string): Promise<RuntimeAutoMergedFile> {
	if (!validateGitPath(path)) {
		return { path, oldContent: "", newContent: "" };
	}
	const [oldResult, newResult] = await Promise.all([
		runGit(cwd, ["show", `HEAD:${path}`]),
		runGit(cwd, ["show", `:0:${path}`]),
	]);
	return {
		path,
		oldContent: oldResult.ok ? oldResult.stdout : "",
		newContent: newResult.ok ? newResult.stdout : "",
	};
}

/**
 * Build a complete `RuntimeConflictState` for the given working directory.
 * When called from `runGitMergeAction`, overrides provide known operation/branch.
 * When called from metadata polling, auto-detect via filesystem checks.
 * Returns `null` if no conflict is detected and no overrides are given.
 */
export async function getConflictState(
	cwd: string,
	overrides?: { operation?: "merge" | "rebase"; sourceBranch?: string; autoMergedFiles?: string[] },
): Promise<RuntimeConflictState | null> {
	const detected = await detectActiveConflict(cwd);

	// If there's no active conflict and no overrides forcing an operation, nothing to report.
	if (!detected && !overrides?.operation) {
		return null;
	}

	const operation = overrides?.operation ?? detected?.operation ?? "merge";
	const sourceBranch = overrides?.sourceBranch ?? detected?.sourceBranch ?? null;
	const currentStep = detected?.currentStep ?? null;
	const totalSteps = detected?.totalSteps ?? null;

	const conflictedFiles = await getConflictedFiles(cwd);
	const autoMergedFiles = overrides?.autoMergedFiles ?? (await computeAutoMergedFiles(cwd, conflictedFiles));

	return {
		operation,
		sourceBranch,
		currentStep,
		totalSteps,
		conflictedFiles,
		autoMergedFiles,
	};
}

// ---------------------------------------------------------------------------
// Conflict resolution actions
// ---------------------------------------------------------------------------

/**
 * Resolve a single conflicted file by choosing "ours" or "theirs", then stage it.
 */
export async function resolveConflictFile(
	cwd: string,
	path: string,
	resolution: "ours" | "theirs",
): Promise<{ ok: boolean; error?: string }> {
	if (!validateGitPath(path)) {
		return { ok: false, error: "Invalid file path." };
	}
	const checkoutResult = await runGit(cwd, ["checkout", `--${resolution}`, "--", path]);
	if (!checkoutResult.ok) {
		return { ok: false, error: checkoutResult.error ?? `Failed to checkout --${resolution} for ${path}.` };
	}

	const addResult = await runGit(cwd, ["add", "--", path]);
	if (!addResult.ok) {
		return { ok: false, error: addResult.error ?? `Failed to stage resolved file ${path}.` };
	}

	return { ok: true };
}

/**
 * Continue an in-progress merge or rebase after conflicts have been resolved.
 * If new conflicts appear (e.g. during a multi-step rebase), returns the new conflict state.
 */
export async function continueMergeOrRebase(cwd: string): Promise<RuntimeConflictContinueResponse> {
	const detected = await detectActiveConflict(cwd);

	let continueResult: { ok: boolean; output: string; stdout: string; error: string | null };
	if (detected?.operation === "rebase") {
		continueResult = await runGit(cwd, ["-c", "core.editor=true", "rebase", "--continue"]);
	} else {
		// Default to merge commit (also handles case where detected is null — graceful attempt)
		continueResult = await runGit(cwd, ["commit", "--no-edit"]);
	}

	// Check if new conflicts appeared after the continue
	const lsUnmerged = await runGit(cwd, ["ls-files", "-u"]);
	const hasNewConflicts = lsUnmerged.ok && lsUnmerged.stdout.trim().length > 0;
	const summary = await getGitSyncSummary(cwd);

	if (hasNewConflicts) {
		const conflictState = await getConflictState(cwd);
		return {
			ok: false,
			completed: false,
			conflictState: conflictState ?? undefined,
			summary,
			output: continueResult.output,
		};
	}

	if (continueResult.ok) {
		return {
			ok: true,
			completed: true,
			summary,
			output: continueResult.output,
		};
	}

	// Command failed without new conflicts — some other error
	return {
		ok: false,
		completed: false,
		summary,
		output: continueResult.output,
		error: continueResult.error ?? "Continue operation failed.",
	};
}

/**
 * Abort an in-progress merge or rebase, restoring the working tree to a clean state.
 * If no active conflict is detected, returns a graceful no-op success.
 */
export async function abortMergeOrRebase(cwd: string): Promise<RuntimeConflictAbortResponse> {
	const detected = await detectActiveConflict(cwd);

	if (!detected) {
		const summary = await getGitSyncSummary(cwd);
		return { ok: true, summary };
	}

	const abortArgs = detected.operation === "rebase" ? ["rebase", "--abort"] : ["merge", "--abort"];
	const abortResult = await runGit(cwd, abortArgs);
	const summary = await getGitSyncSummary(cwd);

	if (!abortResult.ok) {
		return {
			ok: false,
			summary,
			error: abortResult.error ?? `Failed to abort ${detected.operation}.`,
		};
	}

	return { ok: true, summary };
}

// ---------------------------------------------------------------------------
// Merge action
// ---------------------------------------------------------------------------

export async function runGitMergeAction(options: { cwd: string; branch: string }): Promise<RuntimeGitMergeResponse> {
	const branchToMerge = options.branch.trim();
	const repoRoot = await resolveRepoRoot(options.cwd);
	const initialSummary = await getGitSyncSummary(repoRoot);

	if (!branchToMerge || !validateGitRef(branchToMerge)) {
		return {
			ok: false,
			branch: branchToMerge,
			summary: initialSummary,
			output: "",
			error: "Invalid branch name.",
		};
	}

	if (initialSummary.currentBranch === branchToMerge) {
		return {
			ok: false,
			branch: branchToMerge,
			summary: initialSummary,
			output: "",
			error: "Cannot merge a branch into itself.",
		};
	}

	const mergeResult = await runGit(repoRoot, ["merge", branchToMerge, "--no-commit", "--no-edit"]);

	if (!mergeResult.ok) {
		// Check if this is a conflict (unmerged files present) vs some other merge error
		const lsUnmerged = await runGit(repoRoot, ["ls-files", "-u"]);
		const hasConflicts = lsUnmerged.ok && lsUnmerged.stdout.trim().length > 0;

		if (hasConflicts) {
			// Conflict detected — leave the merge in progress so the user can resolve.
			// Compute auto-merged files (staged but not conflicted).
			const conflictedFiles = await getConflictedFiles(repoRoot);
			const autoMergedFiles = await computeAutoMergedFiles(repoRoot, conflictedFiles);
			const conflictState = await getConflictState(repoRoot, {
				operation: "merge",
				sourceBranch: branchToMerge,
				autoMergedFiles,
			});
			const conflictSummary = await getGitSyncSummary(repoRoot);
			return {
				ok: false,
				branch: branchToMerge,
				summary: conflictSummary,
				output: mergeResult.output,
				conflictState: conflictState ?? undefined,
			};
		}

		// Non-conflict merge failure — abort to restore clean state
		await runGit(repoRoot, ["merge", "--abort"]);
		const abortedSummary = await getGitSyncSummary(repoRoot);

		const hasUncommittedChanges =
			mergeResult.output.includes("Your local changes") || mergeResult.output.includes("overwritten by merge");
		const error = hasUncommittedChanges
			? "Merge failed — you have uncommitted changes that would be overwritten. Commit or stash your changes first."
			: `Merge failed and was aborted. The branch may have conflicts with ${initialSummary.currentBranch ?? "the current branch"}.`;

		return {
			ok: false,
			branch: branchToMerge,
			summary: abortedSummary,
			output: mergeResult.output,
			error,
		};
	}

	// --no-commit succeeded (no conflicts) — auto-commit to finalize the merge.
	// For fast-forward merges, git ignores --no-commit and commits directly,
	// so only run commit if MERGE_HEAD exists (indicating a real merge in progress).
	const detected = await detectActiveConflict(repoRoot);
	if (detected) {
		const commitResult = await runGit(repoRoot, ["commit", "--no-edit"]);
		if (!commitResult.ok) {
			const nextSummary = await getGitSyncSummary(repoRoot);
			return {
				ok: false,
				branch: branchToMerge,
				summary: nextSummary,
				output: [mergeResult.output, commitResult.output].filter(Boolean).join("\n"),
				error: commitResult.error ?? "Merge succeeded but commit failed.",
			};
		}
	}

	const nextSummary = await getGitSyncSummary(repoRoot);
	return {
		ok: true,
		branch: branchToMerge,
		summary: nextSummary,
		output: mergeResult.output,
	};
}
