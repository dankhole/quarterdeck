import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { RuntimeGitRepositoryInfo } from "../core";
import type { LockRequest } from "../fs";
import { runGitSync } from "../workspace";

// --- Path constants and getters ---

const RUNTIME_HOME_DIR = ".quarterdeck";
const RUNTIME_WORKTREES_DIR = "worktrees";
const WORKSPACES_DIR = "workspaces";

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

export function getWorkspacesRootPath(): string {
	return join(getRuntimeHomePath(), WORKSPACES_DIR);
}

export function getWorkspaceIndexPath(): string {
	return join(getWorkspacesRootPath(), INDEX_FILENAME);
}

export function getWorkspaceDirectoryPath(workspaceId: string): string {
	return join(getWorkspacesRootPath(), workspaceId);
}

export function getWorkspaceBoardPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), BOARD_FILENAME);
}

export function getWorkspaceSessionsPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), SESSIONS_FILENAME);
}

export function getWorkspaceMetaPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), META_FILENAME);
}

export function getWorkspacePinnedBranchesPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), PINNED_BRANCHES_FILENAME);
}

export function getWorkspaceIndexLockRequest(): LockRequest {
	return {
		path: getWorkspaceIndexPath(),
		type: "file",
	};
}

export function getWorkspaceDirectoryLockRequest(workspaceId: string): LockRequest {
	return {
		path: getWorkspaceDirectoryPath(workspaceId),
		type: "directory",
		lockfilePath: join(getWorkspacesRootPath(), `${workspaceId}.lock`),
	};
}

export function getWorkspacesRootLockRequest(): LockRequest {
	return {
		path: getWorkspacesRootPath(),
		type: "directory",
		lockfileName: ".workspaces.lock",
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
		if (normalized) {
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

export async function resolveWorkspacePath(cwd: string): Promise<string> {
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
