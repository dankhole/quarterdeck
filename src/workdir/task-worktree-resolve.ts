import { resolve } from "node:path";

import type { RuntimeBoardData, RuntimeTaskWorktreeInfoResponse } from "../core";
import { findCardInBoard } from "../core";
import { loadProjectContext, loadProjectState } from "../state";
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
	const context = await loadProjectContext(options.cwd);

	const normalizedBaseRef = options.baseRef.trim();
	if (!normalizedBaseRef) {
		throw new Error("Task base branch is required for task worktree resolution.");
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
	projectPath: string;
	taskId: string;
	baseRef: string;
	ensure?: boolean;
	branch?: string | null;
}): Promise<string> {
	const state = await loadProjectState(options.projectPath);
	const persisted = getTaskWorkingDirectory(state.board, options.taskId);
	if (persisted && (await pathExists(persisted))) return resolve(persisted);

	// Fallback for tasks started before workingDirectory was persisted.
	try {
		return resolve(
			await resolveTaskCwd({
				cwd: options.projectPath,
				taskId: options.taskId,
				baseRef: options.baseRef,
				ensure: options.ensure ?? false,
				branch: options.branch,
			}),
		);
	} catch (error) {
		// Legacy non-worktree tasks (useWorktree === false) have no persisted
		// workingDirectory and no worktree on disk. They use the project path.
		if (isMissingTaskWorktreeError(error)) {
			const card = findCardInBoard(state.board, options.taskId);
			if (card && card.useWorktree === false) {
				return resolve(options.projectPath);
			}
		}
		throw error;
	}
}

export function getTaskWorkingDirectory(board: RuntimeBoardData, taskId: string): string | null {
	const card = findCardInBoard(board, taskId);
	return card?.workingDirectory ?? null;
}

export async function getTaskWorktreePathInfo(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<Pick<RuntimeTaskWorktreeInfoResponse, "taskId" | "path" | "exists" | "baseRef">> {
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const normalizedBaseRef = options.baseRef.trim();
	const repoPath = options.cwd.trim();

	if (!repoPath) {
		throw new Error("Task worktree root is required for task worktree info.");
	}

	if (!normalizedBaseRef) {
		throw new Error("Task base branch is required for task worktree info.");
	}

	const worktreePath = getTaskWorktreePath(repoPath, taskId);
	return {
		taskId,
		path: worktreePath,
		exists: await pathExists(worktreePath),
		baseRef: normalizedBaseRef,
	};
}

export async function getTaskWorktreeInfo(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<RuntimeTaskWorktreeInfoResponse> {
	const projectPathInfo = await getTaskWorktreePathInfo(options);
	if (!projectPathInfo.exists) {
		return {
			taskId: projectPathInfo.taskId,
			path: projectPathInfo.path,
			exists: false,
			baseRef: projectPathInfo.baseRef,
			branch: null,
			isDetached: false,
			headCommit: null,
		};
	}

	const headInfo = await readGitHeadInfo(projectPathInfo.path);
	return {
		taskId: projectPathInfo.taskId,
		path: projectPathInfo.path,
		exists: true,
		baseRef: projectPathInfo.baseRef,
		branch: headInfo.branch,
		isDetached: headInfo.isDetached,
		headCommit: headInfo.headCommit,
	};
}
