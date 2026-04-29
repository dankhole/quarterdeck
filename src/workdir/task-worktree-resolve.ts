import { resolve } from "node:path";

import type { RuntimeBoardData, RuntimeTaskRepositoryInfoResponse } from "../core";
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
	const card = findCardInBoard(state.board, options.taskId);
	if (card?.useWorktree === false) return resolve(options.projectPath);

	const persisted = card?.workingDirectory ?? null;
	if (persisted && (await pathExists(persisted))) return resolve(persisted);

	// Fallback for tasks started before workingDirectory was persisted.
	return resolve(
		await resolveTaskCwd({
			cwd: options.projectPath,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: options.ensure ?? false,
			branch: options.branch,
		}),
	);
}

export function getTaskWorkingDirectory(board: RuntimeBoardData, taskId: string): string | null {
	const card = findCardInBoard(board, taskId);
	return card?.workingDirectory ?? null;
}

export async function getTaskWorktreePathInfo(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<Pick<RuntimeTaskRepositoryInfoResponse, "taskId" | "path" | "exists" | "baseRef">> {
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

export async function getTaskRepositoryInfo(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<RuntimeTaskRepositoryInfoResponse> {
	const projectPathInfo = await getTaskWorktreePathInfo(options);
	try {
		const assignedPath = await resolveTaskWorkingDirectory({
			projectPath: options.cwd,
			taskId: options.taskId,
			baseRef: projectPathInfo.baseRef,
		});
		if (await pathExists(assignedPath)) {
			const headInfo = await readGitHeadInfo(assignedPath);
			return {
				taskId: projectPathInfo.taskId,
				path: assignedPath,
				exists: true,
				baseRef: projectPathInfo.baseRef,
				branch: headInfo.branch,
				isDetached: headInfo.isDetached,
				headCommit: headInfo.headCommit,
			};
		}
	} catch {
		// Missing isolated task worktrees still use the explicit not-created shape below.
	}

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

/** @deprecated Use getTaskRepositoryInfo. */
export const getTaskWorktreeInfo = getTaskRepositoryInfo;
