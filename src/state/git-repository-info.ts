import { normalizeFileSystemPathForComparison, type RuntimeGitRepositoryInfo } from "../core/index.js";
import { isGitCommandIndeterminate, runGit } from "../workdir/git-utils.js";

// --- Mechanism: load current git repository info for a path ---

type GitRepositoryInfoLoadOutcome = { kind: "loaded"; info: RuntimeGitRepositoryInfo } | { kind: "indeterminate" };

function degradedGitRepositoryInfo(): RuntimeGitRepositoryInfo {
	return { currentBranch: null, defaultBranch: null, branches: [] };
}

/** Parse `for-each-ref --format=%(refname:short) refs/heads` output into a sorted, de-duplicated branch list. */
function parseGitBranchesOutput(output: string | null): string[] {
	if (!output) {
		return [];
	}

	const unique = new Set<string>();
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "HEAD") {
			continue;
		}
		unique.add(trimmed);
	}
	return Array.from(unique).sort((left, right) => left.localeCompare(right));
}

function resolveGitDefaultBranch(remoteHead: string | null, branches: string[]): string | null {
	if (remoteHead) {
		const normalized = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
		if (normalized && branches.includes(normalized)) {
			return normalized;
		}
	}
	if (branches.includes("main")) {
		return "main";
	}
	if (branches.includes("master")) {
		return "master";
	}
	return branches[0] ?? null;
}

/**
 * Run the four inspection commands via `runGit` directly so a command that never
 * produced Git's own answer (see `isGitCommandIndeterminate`: a timeout, an
 * overlong process-queue wait, a blocked launch, a signal death, or resource
 * exhaustion) can be told apart from one that definitively answered "no"
 * (detached HEAD, no origin/HEAD, an empty repository). Only a genuine
 * "not a git repository" root failure throws; everything else is returned as a
 * discriminated outcome for the caller to apply fallback/caching policy to.
 * Project loads and state publication await these probes, so use foreground
 * admission (reserved capacity and a bounded queue wait), retaining metadata's
 * short execution timeout. Background priority could starve those callers.
 */
async function loadGitRepositoryInfo(repoPath: string): Promise<GitRepositoryInfoLoadOutcome> {
	const rootResult = await runGit(repoPath, ["--no-optional-locks", "rev-parse", "--show-toplevel"], {
		timeoutClass: "metadata",
		priority: "foreground",
	});
	if (!rootResult.ok) {
		if (isGitCommandIndeterminate(rootResult)) {
			return { kind: "indeterminate" };
		}
		throw new Error(`No git repository detected at ${repoPath}`);
	}
	const gitRoot = rootResult.stdout || null;
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${repoPath}`);
	}

	const [branchResult, branchesResult, remoteHeadResult] = await Promise.all([
		runGit(gitRoot, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
			timeoutClass: "metadata",
			priority: "foreground",
		}),
		// TODO: support showing remote branches again once worktree creation can safely
		// fetch/pull and resolve missing local tracking branches automatically.
		runGit(gitRoot, ["--no-optional-locks", "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
			timeoutClass: "metadata",
			priority: "foreground",
		}),
		runGit(gitRoot, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
			timeoutClass: "metadata",
			priority: "foreground",
		}),
	]);
	for (const result of [branchResult, branchesResult, remoteHeadResult]) {
		if (isGitCommandIndeterminate(result)) {
			return { kind: "indeterminate" };
		}
	}

	const currentBranch = branchResult.ok ? branchResult.stdout || null : null;
	const branches = parseGitBranchesOutput(branchesResult.ok ? branchesResult.stdout : null);
	const remoteHead = remoteHeadResult.ok ? remoteHeadResult.stdout || null : null;
	const orderedBranches = currentBranch && !branches.includes(currentBranch) ? [currentBranch, ...branches] : branches;
	const defaultBranch = resolveGitDefaultBranch(remoteHead, orderedBranches);

	return { kind: "loaded", info: { currentBranch, defaultBranch, branches: orderedBranches } };
}

// --- Policy: TTL cache, last-known-good fallback, and indeterminate retry floor ---

const GIT_REPOSITORY_INFO_CACHE_TTL_MS = 30_000;
// Bounds how often an indeterminate probe re-spawns all four commands for one
// path: within this floor after an indeterminate result, serve the fallback
// immediately instead. Distinct from the TTL cache: never caches the fallback
// as fresh. 0 disables the floor (always retry).
const INDETERMINATE_GIT_INFO_RETRY_FLOOR_MS = 5_000;

interface CachedGitRepositoryInfo {
	info: RuntimeGitRepositoryInfo;
	loadedAt: number;
}

/** Per-key bookkeeping so a load started before an invalidation (or superseded by a later load) can never win a write race. */
interface GitRepositoryInfoKeyState {
	/** Bumped by invalidateGitRepositoryInfoCache; a load must match this at write time. */
	generation: number;
	/** Next sequence number to assign to a load starting now. */
	nextSequence: number;
	/** Sequence of the load that most recently wrote (or retired) the last-known-good entry. */
	lastWrittenLkgSequence: number;
}

const gitRepositoryInfoCache = new Map<string, CachedGitRepositoryInfo>();
const gitRepositoryInfoLoadPromises = new Map<string, Promise<RuntimeGitRepositoryInfo>>();
const keyState = new Map<string, GitRepositoryInfoKeyState>();

// Last-known-good git info per path, kept separate from the TTL cache: an
// indeterminate probe falls back to this so it never replaces a known-good
// branch list with an empty one. A per-path invalidate does NOT clear this:
// metadata polling invalidates on every poll, the browser already holds it,
// and the next successful load corrects it. Only the no-argument (global)
// invalidate, or a definite "not a repository" answer, clears it.
const lastKnownGoodGitRepositoryInfo = new Map<string, RuntimeGitRepositoryInfo>();

// Per-path deadline until which an indeterminate result is served from the
// fallback above without re-running git.
const indeterminateGitInfoRetryUntil = new Map<string, number>();

function normalizeGitRepositoryCacheKey(repoPath: string): string {
	return normalizeFileSystemPathForComparison(repoPath);
}

function stateFor(key: string): GitRepositoryInfoKeyState {
	let state = keyState.get(key);
	if (!state) {
		state = { generation: 0, nextSequence: 0, lastWrittenLkgSequence: -1 };
		keyState.set(key, state);
	}
	return state;
}

export function invalidateGitRepositoryInfoCache(repoPath?: string): void {
	if (!repoPath) {
		const keys = new Set<string>([
			...gitRepositoryInfoCache.keys(),
			...gitRepositoryInfoLoadPromises.keys(),
			...lastKnownGoodGitRepositoryInfo.keys(),
			...indeterminateGitInfoRetryUntil.keys(),
			...keyState.keys(),
		]);
		for (const key of keys) stateFor(key).generation += 1;
		gitRepositoryInfoCache.clear();
		gitRepositoryInfoLoadPromises.clear();
		lastKnownGoodGitRepositoryInfo.clear();
		indeterminateGitInfoRetryUntil.clear();
		return;
	}
	const cacheKey = normalizeGitRepositoryCacheKey(repoPath);
	stateFor(cacheKey).generation += 1;
	gitRepositoryInfoCache.delete(cacheKey);
	gitRepositoryInfoLoadPromises.delete(cacheKey);
	indeterminateGitInfoRetryUntil.delete(cacheKey);
}

/**
 * Applies load results to the shared caches. A write is only honored if the key's
 * generation at the end of the load still matches the generation captured when
 * the load started (an invalidation in between retires it); the last-known-good
 * write additionally requires this load's sequence to be newer than whichever
 * load last wrote it, so a slower, earlier-started load can never clobber it.
 */
async function runLoadAndApplyPolicy(
	repoPath: string,
	cacheKey: string,
	generationAtStart: number,
	sequence: number,
): Promise<RuntimeGitRepositoryInfo> {
	let outcome: GitRepositoryInfoLoadOutcome;
	try {
		outcome = await loadGitRepositoryInfo(repoPath);
	} catch (error) {
		// A definite "not a repository" answer retires the fallback: the old branch
		// list no longer describes this path, so a later timeout must not revive it.
		const state = stateFor(cacheKey);
		if (state.generation === generationAtStart && sequence > state.lastWrittenLkgSequence) {
			lastKnownGoodGitRepositoryInfo.delete(cacheKey);
			state.lastWrittenLkgSequence = sequence;
		}
		throw error;
	}
	const state = stateFor(cacheKey);
	const generationStillCurrent = state.generation === generationAtStart;

	if (outcome.kind === "loaded") {
		if (generationStillCurrent) {
			gitRepositoryInfoCache.set(cacheKey, { info: outcome.info, loadedAt: Date.now() });
			indeterminateGitInfoRetryUntil.delete(cacheKey);
			if (sequence > state.lastWrittenLkgSequence) {
				lastKnownGoodGitRepositoryInfo.set(cacheKey, outcome.info);
				state.lastWrittenLkgSequence = sequence;
			}
		}
		return outcome.info;
	}

	if (generationStillCurrent && INDETERMINATE_GIT_INFO_RETRY_FLOOR_MS > 0) {
		indeterminateGitInfoRetryUntil.set(cacheKey, Date.now() + INDETERMINATE_GIT_INFO_RETRY_FLOOR_MS);
	}
	return lastKnownGoodGitRepositoryInfo.get(cacheKey) ?? degradedGitRepositoryInfo();
}

/**
 * Current git info for a project. Never throws for an indeterminate probe
 * (timeout, blocked launch, resource exhaustion): it returns the last-known-good
 * info for this path if this process has one, otherwise a degraded empty value.
 * Only a definitive "no git repository" root failure still throws.
 */
export async function detectGitRepositoryInfo(repoPath: string): Promise<RuntimeGitRepositoryInfo> {
	const cacheKey = normalizeGitRepositoryCacheKey(repoPath);
	const cached = gitRepositoryInfoCache.get(cacheKey);
	if (cached && Date.now() - cached.loadedAt < GIT_REPOSITORY_INFO_CACHE_TTL_MS) {
		return cached.info;
	}

	const existingLoad = gitRepositoryInfoLoadPromises.get(cacheKey);
	if (existingLoad) {
		return await existingLoad;
	}

	const retryFloorUntil = indeterminateGitInfoRetryUntil.get(cacheKey);
	if (retryFloorUntil !== undefined && Date.now() < retryFloorUntil) {
		return lastKnownGoodGitRepositoryInfo.get(cacheKey) ?? degradedGitRepositoryInfo();
	}

	const state = stateFor(cacheKey);
	const generationAtStart = state.generation;
	const sequence = state.nextSequence++;
	const loadPromise = runLoadAndApplyPolicy(repoPath, cacheKey, generationAtStart, sequence);
	gitRepositoryInfoLoadPromises.set(cacheKey, loadPromise);
	try {
		return await loadPromise;
	} finally {
		// An invalidation (or a prior buggy delete) must not let this stale
		// `finally` evict a different, newer in-flight promise for the same key.
		if (gitRepositoryInfoLoadPromises.get(cacheKey) === loadPromise) {
			gitRepositoryInfoLoadPromises.delete(cacheKey);
		}
	}
}
