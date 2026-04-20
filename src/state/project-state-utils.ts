import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { RuntimeGitRepositoryInfo } from "../core";
import type { LockRequest } from "../fs";
import { runGitSync } from "../workdir";

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

export function isUnderWorktreesHome(repoPath: string): boolean {
	const worktreesHome = getTaskWorktreesHomePath();
	const normalized = resolve(repoPath);
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

function detectGitRoot(cwd: string): string | null {
	return runGitSync(cwd, ["rev-parse", "--show-toplevel"]);
}

function detectGitCurrentBranch(repoPath: string): string | null {
	return runGitSync(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

function detectGitBranches(repoPath: string): string[] {
	// TODO: support showing remote branches again once worktree creation can safely fetch/pull
	// and resolve missing local tracking branches automatically.
	const output = runGitSync(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
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

function detectGitDefaultBranch(repoPath: string, branches: string[]): string | null {
	const remoteHead = runGitSync(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
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

export function detectGitRepositoryInfo(repoPath: string): RuntimeGitRepositoryInfo {
	const gitRoot = detectGitRoot(repoPath);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${repoPath}`);
	}

	const currentBranch = detectGitCurrentBranch(repoPath);
	const branches = detectGitBranches(repoPath);
	const orderedBranches = currentBranch && !branches.includes(currentBranch) ? [currentBranch, ...branches] : branches;
	const defaultBranch = detectGitDefaultBranch(repoPath, orderedBranches);

	return {
		currentBranch,
		defaultBranch,
		branches: orderedBranches,
	};
}

export async function resolveProjectPath(cwd: string): Promise<string> {
	const resolvedCwd = resolve(cwd);
	let canonicalCwd = resolvedCwd;
	try {
		canonicalCwd = await realpath(resolvedCwd);
	} catch {
		canonicalCwd = resolvedCwd;
	}

	const gitRoot = detectGitRoot(canonicalCwd);
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
