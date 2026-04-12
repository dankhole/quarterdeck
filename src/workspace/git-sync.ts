import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	RuntimeAutoMergedFile,
	RuntimeConflictAbortResponse,
	RuntimeConflictContinueResponse,
	RuntimeConflictFile,
	RuntimeConflictState,
	RuntimeGitCheckoutResponse,
	RuntimeGitCherryPickResponse,
	RuntimeGitCommitResponse,
	RuntimeGitCreateBranchResponse,
	RuntimeGitDeleteBranchResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitMergeResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeGitSyncSummary,
	RuntimeStashDropResponse,
	RuntimeStashEntry,
	RuntimeStashListResponse,
	RuntimeStashPopApplyResponse,
	RuntimeStashPushResponse,
	RuntimeStashShowResponse,
} from "../core/api-contract";
import { runGit, validateGitPath, validateGitRef } from "./git-utils";

interface GitPathFingerprint {
	path: string;
	size: number | null;
	mtimeMs: number | null;
	ctimeMs: number | null;
}

export interface GitWorkspaceProbe {
	repoRoot: string;
	headCommit: string | null;
	currentBranch: string | null;
	upstreamBranch: string | null;
	aheadCount: number;
	behindCount: number;
	changedFiles: number;
	untrackedPaths: string[];
	pathFingerprints: GitPathFingerprint[];
	stateToken: string;
}

function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split("\n").length;
}

function parseNumstatTotals(output: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const [addedRaw, deletedRaw] = line.split("\t");
		const added = Number.parseInt(addedRaw ?? "", 10);
		const deleted = Number.parseInt(deletedRaw ?? "", 10);
		if (Number.isFinite(added)) {
			additions += added;
		}
		if (Number.isFinite(deleted)) {
			deletions += deleted;
		}
	}

	return { additions, deletions };
}

function parseAheadBehindCounts(output: string): { aheadCount: number; behindCount: number } {
	const [aheadRaw, behindRaw] = output.trim().split(/\s+/, 2);
	const ahead = Math.abs(Number.parseInt(aheadRaw ?? "", 10));
	const behind = Math.abs(Number.parseInt(behindRaw ?? "", 10));
	return {
		aheadCount: Number.isFinite(ahead) ? ahead : 0,
		behindCount: Number.isFinite(behind) ? behind : 0,
	};
}

function buildFingerprintToken(fingerprints: GitPathFingerprint[]): string {
	return fingerprints
		.map((entry) => `${entry.path}\t${entry.size ?? "null"}\t${entry.mtimeMs ?? "null"}\t${entry.ctimeMs ?? "null"}`)
		.join("\n");
}

async function buildPathFingerprints(repoRoot: string, paths: string[]): Promise<GitPathFingerprint[]> {
	const uniqueSortedPaths = Array.from(new Set(paths)).sort((left, right) => left.localeCompare(right));
	return await Promise.all(
		uniqueSortedPaths.map(async (path) => {
			try {
				const fileStat = await stat(join(repoRoot, path));
				return {
					path,
					size: fileStat.size,
					mtimeMs: fileStat.mtimeMs,
					ctimeMs: fileStat.ctimeMs,
				} satisfies GitPathFingerprint;
			} catch {
				return {
					path,
					size: null,
					mtimeMs: null,
					ctimeMs: null,
				} satisfies GitPathFingerprint;
			}
		}),
	);
}

function parseStatusPath(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}
	const parts = trimmed.split("\t");
	const metadata = parts[0]?.trim() ?? "";
	const tokens = metadata.split(/\s+/);
	return tokens[tokens.length - 1] ?? null;
}

export async function probeGitWorkspaceState(cwd: string): Promise<GitWorkspaceProbe> {
	const repoRoot = await resolveRepoRoot(cwd);
	const [statusResult, headCommitResult] = await Promise.all([
		runGit(repoRoot, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
		runGit(repoRoot, ["--no-optional-locks", "rev-parse", "--verify", "HEAD"]),
	]);

	if (!statusResult.ok) {
		throw new Error(statusResult.error ?? "Git status command failed.");
	}

	let currentBranch: string | null = null;
	let upstreamBranch: string | null = null;
	let aheadCount = 0;
	let behindCount = 0;
	const fingerprintPaths: string[] = [];
	const untrackedPaths: string[] = [];
	let changedFiles = 0;

	for (const rawLine of statusResult.stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		if (line.startsWith("# branch.head ")) {
			const branchName = line.slice("# branch.head ".length).trim();
			currentBranch = branchName && branchName !== "(detached)" ? branchName : null;
			continue;
		}
		if (line.startsWith("# branch.upstream ")) {
			upstreamBranch = line.slice("# branch.upstream ".length).trim() || null;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const counts = parseAheadBehindCounts(line.slice("# branch.ab ".length));
			aheadCount = counts.aheadCount;
			behindCount = counts.behindCount;
			continue;
		}
		if (line.startsWith("? ")) {
			const path = line.slice(2).trim();
			if (!path) {
				continue;
			}
			changedFiles += 1;
			untrackedPaths.push(path);
			fingerprintPaths.push(path);
			continue;
		}
		if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
			const path = parseStatusPath(line);
			if (!path) {
				continue;
			}
			changedFiles += 1;
			fingerprintPaths.push(path);
			const renameParts = line.split("\t");
			const previousPath = renameParts[1]?.trim();
			if (previousPath) {
				fingerprintPaths.push(previousPath);
			}
		}
	}

	const headCommit = headCommitResult.ok && headCommitResult.stdout ? headCommitResult.stdout : null;
	const fingerprints = await buildPathFingerprints(repoRoot, fingerprintPaths);

	return {
		repoRoot,
		headCommit,
		currentBranch,
		upstreamBranch,
		aheadCount,
		behindCount,
		changedFiles,
		untrackedPaths,
		pathFingerprints: fingerprints,
		stateToken: [
			repoRoot,
			headCommit ?? "no-head",
			currentBranch ?? "detached",
			upstreamBranch ?? "no-upstream",
			String(aheadCount),
			String(behindCount),
			statusResult.stdout,
			buildFingerprintToken(fingerprints),
		].join("\n--\n"),
	};
}

async function resolveRepoRoot(cwd: string): Promise<string> {
	const result = await runGit(cwd, ["--no-optional-locks", "rev-parse", "--show-toplevel"]);
	if (!result.ok || !result.stdout) {
		throw new Error("No git repository detected for this workspace.");
	}
	return result.stdout;
}

const untrackedLineCountCache = new Map<string, { mtimeMs: number; lineCount: number }>();
const UNTRACKED_CACHE_MAX_SIZE = 2_000;

async function countUntrackedAdditions(
	repoRoot: string,
	untrackedPaths: string[],
	fingerprints: GitPathFingerprint[],
): Promise<number> {
	const fingerprintByPath = new Map(fingerprints.map((fp) => [fp.path, fp]));
	const counts = await Promise.all(
		untrackedPaths.map(async (relativePath) => {
			const absolutePath = join(repoRoot, relativePath);
			const fp = fingerprintByPath.get(relativePath);
			if (fp?.mtimeMs != null) {
				const cached = untrackedLineCountCache.get(absolutePath);
				if (cached && cached.mtimeMs === fp.mtimeMs) {
					return cached.lineCount;
				}
			}
			try {
				const contents = await readFile(absolutePath, "utf8");
				const lineCount = countLines(contents);
				if (fp?.mtimeMs != null) {
					if (untrackedLineCountCache.size >= UNTRACKED_CACHE_MAX_SIZE) {
						const firstKey = untrackedLineCountCache.keys().next().value;
						if (firstKey !== undefined) {
							untrackedLineCountCache.delete(firstKey);
						}
					}
					untrackedLineCountCache.set(absolutePath, { mtimeMs: fp.mtimeMs, lineCount });
				}
				return lineCount;
			} catch {
				return 0;
			}
		}),
	);
	return counts.reduce((total, value) => total + value, 0);
}

async function hasGitRef(repoRoot: string, ref: string): Promise<boolean> {
	const result = await runGit(repoRoot, ["show-ref", "--verify", "--quiet", ref]);
	return result.ok;
}

export async function getGitSyncSummary(
	cwd: string,
	options?: { probe?: GitWorkspaceProbe },
): Promise<RuntimeGitSyncSummary> {
	const probe = options?.probe ?? (await probeGitWorkspaceState(cwd));
	const diffResult = await runGit(probe.repoRoot, ["--no-optional-locks", "diff", "--numstat", "HEAD", "--"]);
	const trackedTotals = diffResult.ok ? parseNumstatTotals(diffResult.stdout) : { additions: 0, deletions: 0 };
	const untrackedAdditions = await countUntrackedAdditions(
		probe.repoRoot,
		probe.untrackedPaths,
		probe.pathFingerprints,
	);

	return {
		currentBranch: probe.currentBranch,
		upstreamBranch: probe.upstreamBranch,
		changedFiles: probe.changedFiles,
		additions: trackedTotals.additions + untrackedAdditions,
		deletions: trackedTotals.deletions,
		aheadCount: probe.aheadCount,
		behindCount: probe.behindCount,
	};
}

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

// ─── Git Stash Operations ────────────────────────────────────────────

/**
 * Stash changes in the working tree.
 * Always includes untracked files via `--include-untracked`.
 * If `paths` is non-empty, only the specified files are stashed.
 */
export async function stashPush(options: {
	cwd: string;
	paths?: string[];
	message?: string;
}): Promise<RuntimeStashPushResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const paths = options.paths ?? [];

	for (const p of paths) {
		if (!validateGitPath(p)) {
			return { ok: false, error: `Invalid file path: ${p}` };
		}
	}

	const args = ["stash", "push", "--include-untracked"];
	if (options.message) {
		args.push("-m", options.message);
	}
	if (paths.length > 0) {
		args.push("--", ...paths);
	}

	const result = await runGit(repoRoot, args);
	if (!result.ok) {
		return { ok: false, error: result.error ?? "Stash push failed." };
	}

	// git stash push exits 0 even when there is nothing to stash.
	if (/no local changes to save/i.test(result.output)) {
		return { ok: false, error: "No local changes to save." };
	}

	return { ok: true };
}

/**
 * List all stash entries with metadata.
 * Uses a custom format to parse index, subject (branch + message), and date.
 */
export async function stashList(cwd: string): Promise<RuntimeStashListResponse> {
	const repoRoot = await resolveRepoRoot(cwd);

	const result = await runGit(repoRoot, ["stash", "list", "--format=%gd%x1f%gs%x1f%ci"]);
	if (!result.ok) {
		return { ok: false, entries: [], error: result.error ?? "Stash list failed." };
	}

	if (!result.stdout) {
		return { ok: true, entries: [] };
	}

	const entries: RuntimeStashEntry[] = [];
	for (const line of result.stdout.split("\n")) {
		if (!line) continue;

		const parts = line.split("\x1f");
		if (parts.length < 3) continue;

		const [refName, subject, dateStr] = parts;

		// Extract index from stash@{N}
		const indexMatch = refName.match(/^stash@\{(\d+)\}$/);
		if (!indexMatch) continue;
		const index = Number.parseInt(indexMatch[1], 10);

		// Extract branch and message from subject.
		// Format: "On <branch>: <message>" or "WIP on <branch>: <hash> <commit-msg>"
		let branch = "";
		let message = subject;
		const subjectMatch = subject.match(/^(?:On|WIP on) ([^:]+):\s*(.*)$/);
		if (subjectMatch) {
			branch = subjectMatch[1];
			message = subjectMatch[2];
		}

		entries.push({ index, message, branch, date: dateStr });
	}

	return { ok: true, entries };
}

/**
 * Pop a stash entry by index, restoring changes and removing the entry.
 * If conflicts occur, the entry is NOT removed (git's default behavior).
 */
export async function stashPop(options: { cwd: string; index: number }): Promise<RuntimeStashPopApplyResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const result = await runGit(repoRoot, ["stash", "pop", `stash@{${options.index}}`]);

	if (!result.ok) {
		// Git writes CONFLICT messages to stdout, not stderr.
		const conflicted = /conflict/i.test(result.output);
		return {
			ok: false,
			conflicted,
			error: conflicted ? "Stash applied with conflicts." : (result.error ?? "Stash pop failed."),
		};
	}

	return { ok: true, conflicted: false };
}

/**
 * Apply a stash entry by index without removing it from the stack.
 * If conflicts occur, changes are partially applied.
 */
export async function stashApply(options: { cwd: string; index: number }): Promise<RuntimeStashPopApplyResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const result = await runGit(repoRoot, ["stash", "apply", `stash@{${options.index}}`]);

	if (!result.ok) {
		// Git writes CONFLICT messages to stdout, not stderr.
		const conflicted = /conflict/i.test(result.output);
		return {
			ok: false,
			conflicted,
			error: conflicted ? "Stash applied with conflicts." : (result.error ?? "Stash apply failed."),
		};
	}

	return { ok: true, conflicted: false };
}

/**
 * Drop a stash entry by index without applying it.
 */
export async function stashDrop(options: { cwd: string; index: number }): Promise<RuntimeStashDropResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const result = await runGit(repoRoot, ["stash", "drop", `stash@{${options.index}}`]);

	if (!result.ok) {
		return { ok: false, error: result.error ?? "Stash drop failed." };
	}

	return { ok: true };
}

/**
 * Show the diff of a stash entry.
 */
export async function stashShow(options: { cwd: string; index: number }): Promise<RuntimeStashShowResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const result = await runGit(repoRoot, ["stash", "show", "-p", `stash@{${options.index}}`]);

	if (!result.ok) {
		return { ok: false, error: result.error ?? "Stash show failed." };
	}

	return { ok: true, diff: result.stdout };
}

/**
 * Count the number of stash entries. Used in metadata polling.
 * Uses `--no-optional-locks` to avoid lock contention with concurrent agent operations.
 */
export async function stashCount(cwd: string): Promise<number> {
	const repoRoot = await resolveRepoRoot(cwd);
	const result = await runGit(repoRoot, ["--no-optional-locks", "stash", "list"]);
	if (!result.ok || !result.stdout) {
		return 0;
	}
	return result.stdout.split("\n").filter(Boolean).length;
}

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
