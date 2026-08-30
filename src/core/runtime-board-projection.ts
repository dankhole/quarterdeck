import { getRuntimeSessionWorkColumn } from "./api/task-indicators.js";
import type { RuntimeBoardData, RuntimeTaskSessionSummary, RuntimeTaskWorktreeMetadata } from "./api-contract";
import { areFileSystemPathsEqual } from "./path-comparison.js";
import { findCardInBoard, getTaskColumnId, moveTaskToColumn, patchTask } from "./task-board-mutations";

export interface RuntimeBoardProjectionResult {
	board: RuntimeBoardData;
	changed: boolean;
}

/**
 * Projects server-owned session truth onto durable work-column placement and
 * launch-path metadata. Backlog and trash remain user-controlled lifecycle
 * states and are never pulled into a work column by a late session update.
 */
export function projectRuntimeSessionsOntoBoard(
	board: RuntimeBoardData,
	summaries: Iterable<RuntimeTaskSessionSummary>,
	projectPath: string,
	platform: NodeJS.Platform = process.platform,
): RuntimeBoardProjectionResult {
	let nextBoard = board;
	let changed = false;

	for (const summary of summaries) {
		let columnId = getTaskColumnId(nextBoard, summary.taskId);
		const targetWorkColumn = getRuntimeSessionWorkColumn(summary);
		if (targetWorkColumn && columnId !== targetWorkColumn && (columnId === "in_progress" || columnId === "review")) {
			const moved = moveTaskToColumn(nextBoard, summary.taskId, targetWorkColumn, summary.updatedAt, {
				targetIndex: 0,
			});
			nextBoard = moved.board;
			changed ||= moved.moved;
			columnId = moved.moved ? targetWorkColumn : columnId;
		}

		const launchPath = summary.sessionLaunchPath?.trim() ?? "";
		if (!launchPath || (columnId !== "in_progress" && columnId !== "review")) {
			continue;
		}
		const card = findCardInBoard(nextBoard, summary.taskId);
		const usesWorktree = !areFileSystemPathsEqual(launchPath, projectPath, platform);
		if (
			!card ||
			(typeof card.workingDirectory === "string" &&
				areFileSystemPathsEqual(card.workingDirectory, launchPath, platform) &&
				card.useWorktree === usesWorktree)
		) {
			continue;
		}
		const patched = patchTask(
			nextBoard,
			summary.taskId,
			{
				workingDirectory: launchPath,
				useWorktree: usesWorktree,
			},
			summary.updatedAt,
		);
		nextBoard = patched.board;
		changed ||= patched.updated;
	}

	return { board: nextBoard, changed };
}

/** Projects git-monitor task metadata onto active cards. */
export function projectRuntimeTaskMetadataOntoBoard(
	board: RuntimeBoardData,
	metadata: Iterable<RuntimeTaskWorktreeMetadata>,
	projectPath: string,
	platform: NodeJS.Platform = process.platform,
): RuntimeBoardProjectionResult {
	let nextBoard = board;
	let changed = false;
	for (const taskMetadata of metadata) {
		const columnId = getTaskColumnId(nextBoard, taskMetadata.taskId);
		if (columnId !== "in_progress" && columnId !== "review") {
			continue;
		}
		const card = findCardInBoard(nextBoard, taskMetadata.taskId);
		if (!card) {
			continue;
		}
		const branch = taskMetadata.branch || undefined;
		const shouldUpdateBranch = branch !== undefined && branch !== card.branch;
		const usesWorktree = !areFileSystemPathsEqual(taskMetadata.path, projectPath, platform);
		const shouldUpdatePath =
			typeof card.workingDirectory !== "string" ||
			!areFileSystemPathsEqual(taskMetadata.path, card.workingDirectory ?? "", platform) ||
			card.useWorktree !== usesWorktree;
		if (!shouldUpdateBranch && !shouldUpdatePath) {
			continue;
		}
		const patched = patchTask(
			nextBoard,
			taskMetadata.taskId,
			{
				...(shouldUpdatePath
					? {
							workingDirectory: taskMetadata.path,
							useWorktree: usesWorktree,
						}
					: {}),
				...(shouldUpdateBranch ? { branch } : {}),
			},
			Date.now(),
		);
		nextBoard = patched.board;
		changed ||= patched.updated;
	}
	return { board: nextBoard, changed };
}

/** Applies a monitor-derived base ref unless the user explicitly pinned it. */
export function projectRuntimeTaskBaseRefOntoBoard(
	board: RuntimeBoardData,
	taskId: string,
	baseRef: string,
): RuntimeBoardProjectionResult {
	const card = findCardInBoard(board, taskId);
	if (!card || card.baseRefPinned === true || card.baseRef === baseRef) {
		return { board, changed: false };
	}
	const patched = patchTask(board, taskId, { baseRef }, Date.now());
	return { board: patched.board, changed: patched.updated };
}
