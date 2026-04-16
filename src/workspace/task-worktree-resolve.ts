import { resolve } from "node:path";

import type { RuntimeBoardData, RuntimeTaskWorkspaceInfoResponse } from "../core/api-contract";
import { findCardInBoard } from "../core/task-board-mutations";
import { loadWorkspaceContext, loadWorkspaceState } from "../state/workspace-state";
import { readGitHeadInfo } from "./git-utils";
import { ensureTaskWorktreeIfDoesntExist, getTaskWorktreePath } from "./task-worktree-lifecycle";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";
import { pathExists } from "./task-worktree-symlinks";

export async function resolveTaskCwd(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
	ensure?: boolean;
	branch?: string | null;
}): Promise<string> {
	const context = await loadWorkspaceContext(options.cwd);

	const normalizedBaseRef = options.baseRef.trim();
	if (!normalizedBaseRef) {
		throw new Error("Task base branch is required for task workspace resolution.");
	}

	if (options.ensure) {
		const ensured = await ensureTaskWorktreeIfDoesntExist({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: normalizedBaseRef,
			branch: options.branch,
		});
		if (!ensured.ok) {
			throw new Error(ensured.error ?? "Worktree setup failed.");
		}
		return ensured.path;
	}

	const worktreePath = getTaskWorktreePath(context.repoPath, options.taskId);
	if (await pathExists(worktreePath)) {
		return worktreePath;
	}
	throw new Error(`Task worktree not found for task "${options.taskId}".`);
}

export function isMissingTaskWorktreeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return error.message.startsWith("Task worktree not found for task ");
}

export async function resolveTaskWorkingDirectory(options: {
	workspacePath: string;
	taskId: string;
	baseRef: string;
	ensure?: boolean;
	branch?: string | null;
}): Promise<string> {
	const state = await loadWorkspaceState(options.workspacePath);
	const persisted = getTaskWorkingDirectory(state.board, options.taskId);
	if (persisted && (await pathExists(persisted))) return resolve(persisted);

	// Fallback for tasks started before workingDirectory was persisted.
	try {
		return resolve(
			await resolveTaskCwd({
				cwd: options.workspacePath,
				taskId: options.taskId,
				baseRef: options.baseRef,
				ensure: options.ensure ?? false,
				branch: options.branch,
			}),
		);
	} catch (error) {
		// Legacy non-worktree tasks (useWorktree === false) have no persisted
		// workingDirectory and no worktree on disk. They use the workspace path.
		if (isMissingTaskWorktreeError(error)) {
			const card = findCardInBoard(state.board, options.taskId);
			if (card && card.useWorktree === false) {
				return resolve(options.workspacePath);
			}
		}
		throw error;
	}
}

export function getTaskWorkingDirectory(board: RuntimeBoardData, taskId: string): string | null {
	const card = findCardInBoard(board, taskId);
	return card?.workingDirectory ?? null;
}

export async function getTaskWorkspacePathInfo(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<Pick<RuntimeTaskWorkspaceInfoResponse, "taskId" | "path" | "exists" | "baseRef">> {
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const normalizedBaseRef = options.baseRef.trim();
	const repoPath = options.cwd.trim();

	if (!repoPath) {
		throw new Error("Task workspace root is required for task workspace info.");
	}

	if (!normalizedBaseRef) {
		throw new Error("Task base branch is required for task workspace info.");
	}

	const worktreePath = getTaskWorktreePath(repoPath, taskId);
	return {
		taskId,
		path: worktreePath,
		exists: await pathExists(worktreePath),
		baseRef: normalizedBaseRef,
	};
}

export async function getTaskWorkspaceInfo(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<RuntimeTaskWorkspaceInfoResponse> {
	const workspacePathInfo = await getTaskWorkspacePathInfo(options);
	if (!workspacePathInfo.exists) {
		return {
			taskId: workspacePathInfo.taskId,
			path: workspacePathInfo.path,
			exists: false,
			baseRef: workspacePathInfo.baseRef,
			branch: null,
			isDetached: false,
			headCommit: null,
		};
	}

	const headInfo = await readGitHeadInfo(workspacePathInfo.path);
	return {
		taskId: workspacePathInfo.taskId,
		path: workspacePathInfo.path,
		exists: true,
		baseRef: workspacePathInfo.baseRef,
		branch: headInfo.branch,
		isDetached: headInfo.isDetached,
		headCommit: headInfo.headCommit,
	};
}
