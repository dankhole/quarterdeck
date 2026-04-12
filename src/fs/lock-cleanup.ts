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
 *     Cleans `~/.quarterdeck/` hierarchy. Safe to call before the workspace
 *     registry is loaded.
 *
 *   Phase 2 — {@link cleanupProjectStaleLockArtifacts}
 *     Cleans per-project directories. Requires project repo paths (typically
 *     read from the workspace index after phase 1 has run).
 *
 * When adding a new lock anywhere in the codebase, register its cleanup target
 * in the appropriate function below so it gets automatic coverage.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { getRuntimeHomePath, getWorkspacesRootPath } from "../state/workspace-state.js";
import { getGitCommonDir } from "../workspace/git-utils.js";
import { cleanupStaleLockAndTempFiles, DEFAULT_LOCK_STALE_MS } from "./locked-file-system.js";

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
	const workspacesRoot = getWorkspacesRootPath();

	const dirs = [runtimeHome, workspacesRoot];

	// Include per-workspace subdirectories (for temp file cleanup).
	try {
		const entries = await readdir(workspacesRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && !entry.name.endsWith(".lock") && !entry.name.includes(".tmp.")) {
				dirs.push(join(workspacesRoot, entry.name));
			}
		}
	} catch {
		// workspacesRoot may not exist yet — safe to skip.
	}

	return dirs;
}

/**
 * Phase 1: Remove stale lock directories and orphaned temp files from the
 * `~/.quarterdeck/` hierarchy. Safe to call before the workspace registry is
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
 * specific entries will be considered for removal — other `.lock` files in the
 * same directory (like git's own `index.lock`) are left untouched.
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
 * - Quarterdeck-owned directories (broad scan) — e.g. `{project}/.quarterdeck/`
 * - Named targets in shared directories — e.g. the worktree setup lock in `.git/`
 */
async function getProjectCleanupTargets(repoPath: string): Promise<{
	ownedDirectories: string[];
	namedTargets: NamedCleanupTarget[];
}> {
	const ownedDirectories: string[] = [];
	const namedTargets: NamedCleanupTarget[] = [];

	// Project config lock: {project}/.quarterdeck/config.json.lock
	// This directory is Quarterdeck-owned, so broad scan is safe.
	ownedDirectories.push(join(repoPath, ".quarterdeck"));

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
 * project repository paths — typically obtained by reading the workspace index
 * after phase 1 has cleaned the `~/.quarterdeck/` hierarchy.
 *
 * Handles two kinds of directories:
 * - Quarterdeck-owned dirs (e.g. `{project}/.quarterdeck/`) — broad artifact scan
 * - Shared dirs (e.g. `.git/`) — only removes specific named Quarterdeck artifacts
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
	]);
}
