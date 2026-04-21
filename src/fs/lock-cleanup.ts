/**
 * Centralized lock artifact cleanup.
 *
 * This module is the single source of truth for the Quarterdeck lock topology.
 * It declares every directory that may contain lock artifacts, distinguishes
 * between Quarterdeck-owned directories (safe for broad `.lock` / `.tmp.*`
 * scanning) and shared directories like `.git/` (targeted removal of specific
 * named artifacts only), and provides a two-phase cleanup API:
 *
 *   Phase 1 — {@link cleanupGlobalStaleLockArtifacts}
 *     Cleans `~/.quarterdeck/` hierarchy. Safe to call before the project
 *     registry is loaded.
 *
 *   Phase 2 — {@link cleanupProjectStaleLockArtifacts}
 *     Cleans per-project directories. Requires project repo paths (typically
 *     read from the project index after phase 1 has run).
 *
 * When adding a new lock anywhere in the codebase, register its cleanup target
 * in the appropriate function below so it gets automatic coverage.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { getProjectsRootPath, getRuntimeHomePath } from "../state/project-state.js";
import { getGitCommonDir, getGitDir } from "../workdir/git-utils.js";
import { cleanupStaleLockAndTempFiles, DEFAULT_LOCK_STALE_MS } from "./locked-file-system.js";
import { isNodeError } from "./node-error.js";

/** Staleness threshold for git index.lock files (seconds). */
const GIT_INDEX_LOCK_STALE_MS = 10_000;

/**
 * Artifact name for the task worktree setup lock created in `.git/` directories.
 * Must match `QUARTERDECK_TASK_WORKTREE_SETUP_LOCKFILE_NAME` in `task-worktree.ts`.
 */
const TASK_WORKTREE_SETUP_LOCK_NAME = "quarterdeck-task-worktree-setup.lock";

type WarnFn = (message: string) => void;

// ---------------------------------------------------------------------------
// Phase 1 — Global cleanup (~/.quarterdeck/ hierarchy)
// ---------------------------------------------------------------------------

/**
 * Resolve all Quarterdeck-owned directories under `~/.quarterdeck/` that may
 * contain lock or temp artifacts. These directories are fully owned by
 * Quarterdeck, so a broad scan for any `.lock` / `.tmp.*` entry is safe.
 */
async function getGlobalCleanupDirectories(): Promise<string[]> {
	const runtimeHome = getRuntimeHomePath();
	const projectsRoot = getProjectsRootPath();

	const dirs = [runtimeHome, projectsRoot];

	// Include per-project subdirectories (for temp file cleanup).
	try {
		const entries = await readdir(projectsRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && !entry.name.endsWith(".lock") && !entry.name.includes(".tmp.")) {
				dirs.push(join(projectsRoot, entry.name));
			}
		}
	} catch {
		// projectsRoot may not exist yet — safe to skip.
	}

	return dirs;
}

/**
 * Phase 1: Remove stale lock directories and orphaned temp files from the
 * `~/.quarterdeck/` hierarchy. Safe to call before the project registry is
 * loaded — only touches Quarterdeck-owned directories.
 */
export async function cleanupGlobalStaleLockArtifacts(warn?: WarnFn): Promise<void> {
	const dirs = await getGlobalCleanupDirectories();
	await cleanupStaleLockAndTempFiles(dirs, undefined, warn);
}

// ---------------------------------------------------------------------------
// Phase 2 — Per-project cleanup
// ---------------------------------------------------------------------------

/**
 * A named lock artifact in a shared directory (e.g. `.git/`). Only these
 * specific entries will be considered for removal by the named cleanup.
 * Git's own `index.lock` is handled separately by {@link cleanStaleGitIndexLocks}.
 */
interface NamedCleanupTarget {
	directory: string;
	names: string[];
}

/**
 * Remove specific named stale artifacts from shared directories.
 * Unlike {@link cleanupStaleLockAndTempFiles}, this only removes entries whose
 * name is in the provided allowlist — making it safe for directories shared
 * with other tools (e.g. `.git/`).
 */
async function cleanupNamedStaleLockArtifacts(
	targets: NamedCleanupTarget[],
	staleMs: number = DEFAULT_LOCK_STALE_MS,
	warn?: WarnFn,
): Promise<void> {
	const now = Date.now();
	for (const target of targets) {
		let entries: string[];
		try {
			entries = await readdir(target.directory);
		} catch {
			continue;
		}
		const allowedNames = new Set(target.names);
		for (const entry of entries) {
			if (!allowedNames.has(entry)) continue;
			const entryPath = join(target.directory, entry);
			try {
				const info = await stat(entryPath);
				if (now - info.mtimeMs < staleMs) continue;
				await rm(entryPath, { recursive: true, force: true });
				warn?.(`Removed stale artifact: ${entryPath}`);
			} catch {
				// Best-effort cleanup — ignore individual failures.
			}
		}
	}
}

/**
 * Resolve cleanup targets for a single project repository.
 *
 * Returns both:
 * - Quarterdeck-owned directories (broad scan)
 * - Named targets in shared directories — e.g. the worktree setup lock in `.git/`
 */
async function getProjectCleanupTargets(repoPath: string): Promise<{
	ownedDirectories: string[];
	namedTargets: NamedCleanupTarget[];
}> {
	const ownedDirectories: string[] = [];
	const namedTargets: NamedCleanupTarget[] = [];

	// Task worktree setup lock: {repo}/.git/quarterdeck-task-worktree-setup.lock
	// The .git/ directory is shared with git — only remove our named artifact.
	try {
		const gitCommonDir = await getGitCommonDir(repoPath);
		namedTargets.push({
			directory: gitCommonDir,
			names: [TASK_WORKTREE_SETUP_LOCK_NAME],
		});
	} catch {
		// Not a git repo or git unavailable — skip.
	}

	return { ownedDirectories, namedTargets };
}

/**
 * Phase 2: Remove stale lock artifacts from per-project directories. Requires
 * project repository paths — typically obtained by reading the project index
 * after phase 1 has cleaned the `~/.quarterdeck/` hierarchy.
 *
 * Handles two kinds of directories:
 * - Quarterdeck-owned dirs — broad artifact scan
 * - Shared dirs (e.g. `.git/`) — only removes specific named Quarterdeck artifacts
 *
 * Also cleans stale git index.lock files from per-worktree git directories,
 * which are left behind when agent processes are killed mid-operation.
 */
export async function cleanupProjectStaleLockArtifacts(projectRepoPaths: string[], warn?: WarnFn): Promise<void> {
	const allOwnedDirs: string[] = [];
	const allNamedTargets: NamedCleanupTarget[] = [];

	for (const repoPath of projectRepoPaths) {
		try {
			const { ownedDirectories, namedTargets } = await getProjectCleanupTargets(repoPath);
			allOwnedDirs.push(...ownedDirectories);
			allNamedTargets.push(...namedTargets);
		} catch {
			// Project may have been removed or is inaccessible — skip.
		}
	}

	await Promise.all([
		allOwnedDirs.length > 0 ? cleanupStaleLockAndTempFiles(allOwnedDirs, undefined, warn) : Promise.resolve(),
		allNamedTargets.length > 0 ? cleanupNamedStaleLockArtifacts(allNamedTargets, undefined, warn) : Promise.resolve(),
		cleanStaleGitIndexLocks(projectRepoPaths, warn),
	]);
}

// ---------------------------------------------------------------------------
// Git index.lock cleanup for worktrees
// ---------------------------------------------------------------------------

/**
 * Remove stale index.lock files from per-worktree git directories.
 *
 * For worktrees, git stores the index in a per-worktree git directory
 * (not the shared .git/index). When a git process is killed mid-operation
 * — typically by SIGTERM when Quarterdeck stops an agent — the lock file
 * is never released. Subsequent git commands in that worktree then fail
 * with "Unable to create index.lock: File exists."
 *
 * This function scans every per-worktree git directory under .git/worktrees/
 * and the main .git/ directory itself, removing index.lock files that are
 * older than the staleness threshold. The age check ensures we never remove
 * a lock held by an actively running git process.
 */
export async function cleanStaleGitIndexLocks(repoOrWorktreePaths: string[], warn?: WarnFn): Promise<void> {
	// Deduplicate to the git common dir so we scan each repo's worktrees once.
	const seenGitDirs = new Set<string>();
	for (const repoPath of repoOrWorktreePaths) {
		try {
			const gitCommonDir = await getGitCommonDir(repoPath);
			seenGitDirs.add(gitCommonDir);
		} catch {
			// Not a git repo or git unavailable — skip.
		}
	}

	for (const gitCommonDir of seenGitDirs) {
		// 1. Check the main repo's index.lock (in the git common dir itself).
		await removeIndexLock(gitCommonDir, false, warn);

		// 2. Check each per-worktree git directory (.git/worktrees/<name>/).
		const worktreesDir = join(gitCommonDir, "worktrees");
		let worktreeEntries: string[];
		try {
			worktreeEntries = await readdir(worktreesDir);
		} catch {
			continue; // No worktrees directory — this repo has no worktrees.
		}

		for (const name of worktreeEntries) {
			const perWorktreeGitDir = join(worktreesDir, name);
			await removeIndexLock(perWorktreeGitDir, false, warn);
		}
	}
}

/**
 * Remove an index.lock from a git directory. When `force` is false (default),
 * only removes the lock if it's older than the staleness threshold — safe for
 * periodic sweeps where a git process might still be running. When `force` is
 * true, removes the lock unconditionally — use only when the owning process is
 * known to be dead (e.g. post-exit cleanup).
 */
async function removeIndexLock(gitDir: string, force: boolean, warn?: WarnFn): Promise<void> {
	const lockPath = join(gitDir, "index.lock");
	try {
		if (!force) {
			const info = await stat(lockPath);
			if (Date.now() - info.mtimeMs < GIT_INDEX_LOCK_STALE_MS) {
				return; // Lock is fresh — a git process is likely still running.
			}
		}
		await rm(lockPath, { force: true });
		warn?.(`Removed stale git index.lock: ${lockPath}`);
	} catch (error) {
		// ENOENT is the common case (no stale lock) — ignore silently.
		if (isNodeError(error, "ENOENT")) {
			return;
		}
		// Other errors (permissions, etc.) — best-effort, skip.
	}
}

/**
 * Clean stale index.lock from a single worktree's git directory.
 * Intended for targeted cleanup after a specific agent process exits.
 *
 * Resolves the per-worktree git directory for the given worktree path
 * and removes any stale index.lock found there.
 */
export async function cleanStaleIndexLockForWorktree(worktreePath: string, warn?: WarnFn): Promise<void> {
	try {
		const gitDir = await getGitDir(worktreePath);
		// force: true — the owning process is known to be dead (post-exit path),
		// so skip the age check and remove immediately.
		await removeIndexLock(gitDir, true, warn);
	} catch {
		// Best effort — worktree may already be removed, or git unavailable.
	}
}
