/**
 * Pure domain logic for task lifecycle operations (kickoff, resume).
 *
 * No React imports — functions here take explicit parameters and return
 * plain data. The companion hook (`use-task-lifecycle.ts`) handles React
 * state, side effects, and async orchestration.
 */

import type { RuntimeTaskWorkspaceInfoResponse, RuntimeWorktreeEnsureResponse } from "@/runtime/types";
import { getTaskColumnId, moveTaskToColumn } from "@/state/board-state";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** Non-isolated tasks run in the home repo — no worktree to create/ensure. */
export function isNonIsolatedTask(task: BoardCard): boolean {
	return task.useWorktree === false;
}

// ---------------------------------------------------------------------------
// Data transforms
// ---------------------------------------------------------------------------

/**
 * Build a `RuntimeTaskWorkspaceInfoResponse` from the result of an
 * `ensureWorktree` call. This bridges the shape difference between the
 * ensure response (which carries `baseCommit`) and the workspace-info
 * shape (which uses `headCommit`).
 */
export function buildWorkspaceInfoFromEnsureResponse(
	taskId: string,
	response: Extract<RuntimeWorktreeEnsureResponse, { ok: true }>,
): RuntimeTaskWorkspaceInfoResponse {
	return {
		taskId,
		path: response.path,
		exists: true,
		baseRef: response.baseRef,
		branch: response.branch ?? null,
		isDetached: !response.branch,
		headCommit: response.baseCommit,
	};
}

// ---------------------------------------------------------------------------
// Board revert helpers
// ---------------------------------------------------------------------------

/**
 * Compute the reverted board state when an optimistic in-progress move
 * needs to be rolled back. Returns `null` if no revert is needed (the card
 * is no longer in the expected column, or the move back is a no-op).
 */
export function revertOptimisticMoveToInProgress(
	board: BoardData,
	taskId: string,
	fromColumnId: BoardColumnId,
): BoardData | null {
	const currentColumnId = getTaskColumnId(board, taskId);
	if (currentColumnId !== "in_progress") {
		return null;
	}
	const reverted = moveTaskToColumn(board, taskId, fromColumnId);
	return reverted.moved ? reverted.board : null;
}

/**
 * Compute the reverted board state when an optimistic trash-to-review
 * move needs to be rolled back. Returns `null` if no revert is needed.
 */
export function revertOptimisticMoveToReview(board: BoardData, taskId: string): BoardData | null {
	const currentColumnId = getTaskColumnId(board, taskId);
	if (currentColumnId !== "review") {
		return null;
	}
	const reverted = moveTaskToColumn(board, taskId, "trash", { insertAtTop: true });
	return reverted.moved ? reverted.board : null;
}

/**
 * Apply a non-optimistic move to in_progress (used when the caller
 * deferred the column move until after workspace + session succeeded).
 * Returns `null` if no move is needed.
 */
export function applyDeferredMoveToInProgress(
	board: BoardData,
	taskId: string,
	fromColumnId: BoardColumnId,
): BoardData | null {
	const currentColumnId = getTaskColumnId(board, taskId);
	if (currentColumnId !== fromColumnId) {
		return null;
	}
	const moved = moveTaskToColumn(board, taskId, "in_progress", { insertAtTop: true });
	return moved.moved ? moved.board : null;
}
