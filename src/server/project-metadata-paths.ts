import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import type { RuntimeBoardData } from "../core";
import { getTaskWorktreePath, getTaskWorktreePathInfo, pathExists } from "../workdir";
import type { CachedTaskWorktreeMetadata } from "./project-metadata-task-cache";

export interface TrackedTaskWorktree {
	taskId: string;
	baseRef: string;
	workingDirectory: string | null;
	useWorktree?: boolean;
}

export interface ResolvedTaskWorktreePath {
	taskId: string;
	path: string;
	normalizedPath: string;
	exists: boolean;
	baseRef: string;
}

export interface ResolvedTaskWorktreeMetadataInput {
	task: TrackedTaskWorktree;
	pathInfo: ResolvedTaskWorktreePath;
	current: CachedTaskWorktreeMetadata | null;
}

export function collectTrackedTasks(board: RuntimeBoardData): TrackedTaskWorktree[] {
	const tracked: TrackedTaskWorktree[] = [];
	for (const column of board.columns) {
		// Backlog and trash cards do not need git metadata polling. Tracking only
		// active columns avoids unnecessary work, and trash paths are reconstructed
		// from task id on the web-ui side.
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			tracked.push({
				taskId: card.id,
				baseRef: card.baseRef,
				workingDirectory: card.workingDirectory ?? null,
				useWorktree: card.useWorktree,
			});
		}
	}
	return tracked;
}

async function normalizePhysicalPath(path: string, exists: boolean): Promise<string> {
	const absolutePath = resolvePath(path);
	if (!exists) {
		return absolutePath;
	}
	try {
		return await realpath(absolutePath);
	} catch {
		return absolutePath;
	}
}

export async function resolveTaskWorktreePath(
	projectPath: string,
	task: TrackedTaskWorktree,
): Promise<ResolvedTaskWorktreePath> {
	if (task.useWorktree === false) {
		const exists = await pathExists(projectPath);
		return {
			taskId: task.taskId,
			path: projectPath,
			normalizedPath: await normalizePhysicalPath(projectPath, exists),
			exists,
			baseRef: task.baseRef,
		};
	}
	// Use the card's workingDirectory if available (set at session start).
	if (task.workingDirectory) {
		const exists = await pathExists(task.workingDirectory);
		return {
			taskId: task.taskId,
			path: task.workingDirectory,
			normalizedPath: await normalizePhysicalPath(task.workingDirectory, exists),
			exists,
			baseRef: task.baseRef,
		};
	}
	if (!task.baseRef.trim()) {
		const worktreePath = getTaskWorktreePath(projectPath, task.taskId);
		const exists = await pathExists(worktreePath);
		return {
			taskId: task.taskId,
			path: worktreePath,
			normalizedPath: await normalizePhysicalPath(worktreePath, exists),
			exists,
			baseRef: "",
		};
	}
	// Fallback for tasks started before workingDirectory was persisted.
	const pathInfo = await getTaskWorktreePathInfo({
		cwd: projectPath,
		taskId: task.taskId,
		baseRef: task.baseRef,
	});
	return {
		taskId: pathInfo.taskId,
		path: pathInfo.path,
		normalizedPath: await normalizePhysicalPath(pathInfo.path, pathInfo.exists),
		exists: pathInfo.exists,
		baseRef: pathInfo.baseRef,
	};
}

export async function resolveTaskWorktreeMetadataInput(
	projectPath: string,
	task: TrackedTaskWorktree,
	current: CachedTaskWorktreeMetadata | null,
): Promise<ResolvedTaskWorktreeMetadataInput> {
	return {
		task,
		pathInfo: await resolveTaskWorktreePath(projectPath, task),
		current,
	};
}
