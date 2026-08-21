import type { RuntimeBoardData, RuntimeTaskSessionSummary, RuntimeTaskWorktreeMetadata } from "./api-contract";
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
): RuntimeBoardProjectionResult {
	let nextBoard = board;
	let changed = false;

	for (const summary of summaries) {
		let columnId = getTaskColumnId(nextBoard, summary.taskId);
		if (summary.state === "awaiting_review" && columnId === "in_progress") {
			const moved = moveTaskToColumn(nextBoard, summary.taskId, "review", summary.updatedAt, { targetIndex: 0 });
			nextBoard = moved.board;
			changed ||= moved.moved;
			columnId = moved.moved ? "review" : columnId;
		} else if (summary.state === "running" && columnId === "review") {
			const moved = moveTaskToColumn(nextBoard, summary.taskId, "in_progress", summary.updatedAt, {
				targetIndex: 0,
			});
			nextBoard = moved.board;
			changed ||= moved.moved;
			columnId = moved.moved ? "in_progress" : columnId;
		}

		const launchPath = summary.sessionLaunchPath?.trim() ?? "";
		if (!launchPath || (columnId !== "in_progress" && columnId !== "review")) {
			continue;
		}
		const card = findCardInBoard(nextBoard, summary.taskId);
		if (!card || (card.workingDirectory === launchPath && card.useWorktree === (launchPath !== projectPath))) {
			continue;
		}
		const patched = patchTask(
			nextBoard,
			summary.taskId,
			{
				workingDirectory: launchPath,
				useWorktree: launchPath !== projectPath,
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
		const shouldUpdatePath =
			taskMetadata.path !== card.workingDirectory || card.useWorktree !== (taskMetadata.path !== projectPath);
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
							useWorktree: taskMetadata.path !== projectPath,
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
