import { realpath } from "node:fs/promises";
import { join, posix, resolve, win32 } from "node:path";

import { isFileSystemPathWithin } from "../core/index.js";
import { getRuntimeHomePath, getRuntimeHomePathForPlatform } from "../core/runtime-state-home.js";
import type { LockRequest } from "../fs/locked-file-system.js";
import { runGit } from "../workdir/git-utils.js";

export { detectGitRepositoryInfo, invalidateGitRepositoryInfoCache } from "./git-repository-info.js";

// --- Path constants and getters ---

const RUNTIME_WORKTREES_DIR = "worktrees";
const PROJECTS_DIR = "projects";

export const INDEX_FILENAME = "index.json";
export const BOARD_FILENAME = "board.json";
export const SESSIONS_FILENAME = "sessions.json";
export const META_FILENAME = "meta.json";
export const PINNED_BRANCHES_FILENAME = "pinned-branches.json";
export const LIFECYCLE_OPERATIONS_FILENAME = "lifecycle-operations.json";
export const EXECUTION_OWNERSHIP_FILENAME = "execution-ownership.json";

function getTaskWorktreesHomePathForPlatform(platform: NodeJS.Platform): string {
	const pathApi = platform === "win32" ? win32 : posix;
	return pathApi.join(getRuntimeHomePathForPlatform(platform), RUNTIME_WORKTREES_DIR);
}

export { getRuntimeHomePath };

export function getTaskWorktreesHomePath(): string {
	return getTaskWorktreesHomePathForPlatform(process.platform);
}

export function isUnderWorktreesHome(repoPath: string, platform: NodeJS.Platform = process.platform): boolean {
	return isFileSystemPathWithin(getTaskWorktreesHomePathForPlatform(platform), repoPath, platform);
}

export function getProjectsRootPath(): string {
	return join(getRuntimeHomePath(), PROJECTS_DIR);
}

export function getProjectIndexPath(): string {
	return join(getProjectsRootPath(), INDEX_FILENAME);
}

export function getProjectDirectoryPath(projectId: string): string {
	return join(getProjectsRootPath(), projectId);
}

export function getProjectBoardPath(projectId: string): string {
	return join(getProjectDirectoryPath(projectId), BOARD_FILENAME);
}

export function getProjectSessionsPath(projectId: string): string {
	return join(getProjectDirectoryPath(projectId), SESSIONS_FILENAME);
}

export function getProjectMetaPath(projectId: string): string {
	return join(getProjectDirectoryPath(projectId), META_FILENAME);
}

export function getProjectPinnedBranchesPath(projectId: string): string {
	return join(getProjectDirectoryPath(projectId), PINNED_BRANCHES_FILENAME);
}

export function getProjectLifecycleOperationsPath(projectId: string): string {
	return join(getProjectDirectoryPath(projectId), LIFECYCLE_OPERATIONS_FILENAME);
}

export function getProjectExecutionOwnershipPath(projectId: string): string {
	return join(getProjectDirectoryPath(projectId), EXECUTION_OWNERSHIP_FILENAME);
}

export function getProjectIndexLockRequest(): LockRequest {
	return {
		path: getProjectIndexPath(),
		type: "file",
	};
}

export function getProjectDirectoryLockRequest(projectId: string): LockRequest {
	return {
		path: getProjectDirectoryPath(projectId),
		type: "directory",
		lockfilePath: join(getProjectsRootPath(), `${projectId}.lock`),
		// Board state, lifecycle journal, and state reads share this lock; concurrent
		// lifecycle workers (Clear Trash) must queue rather than race its retry budget.
		serializeInProcess: true,
	};
}

export function getProjectsRootLockRequest(): LockRequest {
	return {
		path: getProjectsRootPath(),
		type: "directory",
		lockfileName: ".projects.lock",
	};
}

// --- Git detection ---
// The git-info loader, its TTL cache, last-known-good fallback, and retry floor
// policy live in ./git-repository-info.ts (re-exported above). Only the plain
// root lookup used by resolveProjectPath (never cached, no fallback policy)
// stays here.

async function readGitStdout(cwd: string, args: string[]): Promise<string | null> {
	const result = await runGit(cwd, args, { timeoutClass: "metadata" });
	if (!result.ok || !result.stdout) {
		return null;
	}
	return result.stdout;
}

async function detectGitRoot(cwd: string): Promise<string | null> {
	return await readGitStdout(cwd, ["--no-optional-locks", "rev-parse", "--show-toplevel"]);
}

export async function resolveProjectPath(cwd: string): Promise<string> {
	const resolvedCwd = resolve(cwd);
	let canonicalCwd = resolvedCwd;
	try {
		canonicalCwd = await realpath(resolvedCwd);
	} catch {
		canonicalCwd = resolvedCwd;
	}

	const gitRoot = await detectGitRoot(canonicalCwd);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${canonicalCwd}`);
	}

	const resolvedGitRoot = resolve(gitRoot);
	try {
		return await realpath(resolvedGitRoot);
	} catch {
		return resolvedGitRoot;
	}
}
