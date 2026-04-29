import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { RuntimeGitRepositoryInfo } from "../core";
import type { LockRequest } from "../fs";
import { runGit } from "../workdir";

// --- Path constants and getters ---

const RUNTIME_HOME_DIR = ".quarterdeck";
const RUNTIME_WORKTREES_DIR = "worktrees";
const PROJECTS_DIR = "projects";

export const INDEX_FILENAME = "index.json";
export const BOARD_FILENAME = "board.json";
export const SESSIONS_FILENAME = "sessions.json";
export const META_FILENAME = "meta.json";
export const PINNED_BRANCHES_FILENAME = "pinned-branches.json";

export function getRuntimeHomePath(): string {
	const override = process.env.QUARTERDECK_STATE_HOME;
	if (override) {
		return resolve(override);
	}
	return join(homedir(), RUNTIME_HOME_DIR);
}

export function getTaskWorktreesHomePath(): string {
	const override = process.env.QUARTERDECK_STATE_HOME;
	if (override) {
		return join(resolve(override), RUNTIME_WORKTREES_DIR);
	}
	return join(homedir(), RUNTIME_HOME_DIR, RUNTIME_WORKTREES_DIR);
}

function normalizePathForContainment(path: string): string {
	const normalized = resolve(path).replace(/\\/gu, "/").replace(/\/+$/u, "") || "/";
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isUnderWorktreesHome(repoPath: string): boolean {
	const worktreesHome = normalizePathForContainment(getTaskWorktreesHomePath());
	const normalized = normalizePathForContainment(repoPath);
	return normalized === worktreesHome || normalized.startsWith(`${worktreesHome}/`);
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

const GIT_REPOSITORY_INFO_CACHE_TTL_MS = 30_000;

// Repository info is intentionally cached here because project state hydration
// needs branch context, while many project-scoped request paths only need the
// lightweight scope from project-state.ts. If more git mutation entry points are
// added, prefer centralizing invalidation in the git mutation/effects layer over
// adding another one-off invalidateGitRepositoryInfoCache() call.
interface CachedGitRepositoryInfo {
	info: RuntimeGitRepositoryInfo;
	loadedAt: number;
}

const gitRepositoryInfoCache = new Map<string, CachedGitRepositoryInfo>();
const gitRepositoryInfoLoadPromises = new Map<string, Promise<RuntimeGitRepositoryInfo>>();
let gitRepositoryInfoCacheGeneration = 0;

function normalizeGitRepositoryCacheKey(repoPath: string): string {
	return resolve(repoPath);
}

export function invalidateGitRepositoryInfoCache(repoPath?: string): void {
	gitRepositoryInfoCacheGeneration += 1;
	if (!repoPath) {
		gitRepositoryInfoCache.clear();
		gitRepositoryInfoLoadPromises.clear();
		return;
	}
	const cacheKey = normalizeGitRepositoryCacheKey(repoPath);
	gitRepositoryInfoCache.delete(cacheKey);
	gitRepositoryInfoLoadPromises.delete(cacheKey);
}

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

async function detectGitCurrentBranch(repoPath: string): Promise<string | null> {
	return await readGitStdout(repoPath, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"]);
}

async function detectGitBranches(repoPath: string): Promise<string[]> {
	// TODO: support showing remote branches again once worktree creation can safely fetch/pull
	// and resolve missing local tracking branches automatically.
	const output = await readGitStdout(repoPath, [
		"--no-optional-locks",
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads",
	]);
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

async function loadGitRepositoryInfo(repoPath: string): Promise<RuntimeGitRepositoryInfo> {
	const gitRoot = await detectGitRoot(repoPath);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${repoPath}`);
	}

	const [currentBranch, branches, remoteHead] = await Promise.all([
		detectGitCurrentBranch(gitRoot),
		detectGitBranches(gitRoot),
		readGitStdout(gitRoot, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
	]);
	const orderedBranches = currentBranch && !branches.includes(currentBranch) ? [currentBranch, ...branches] : branches;
	const defaultBranch = resolveGitDefaultBranch(remoteHead, orderedBranches);

	return {
		currentBranch,
		defaultBranch,
		branches: orderedBranches,
	};
}

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

	const loadGeneration = gitRepositoryInfoCacheGeneration;
	const loadPromise = loadGitRepositoryInfo(repoPath).then((info) => {
		if (loadGeneration === gitRepositoryInfoCacheGeneration) {
			gitRepositoryInfoCache.set(cacheKey, { info, loadedAt: Date.now() });
		}
		return info;
	});
	gitRepositoryInfoLoadPromises.set(cacheKey, loadPromise);
	try {
		return await loadPromise;
	} finally {
		gitRepositoryInfoLoadPromises.delete(cacheKey);
	}
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
