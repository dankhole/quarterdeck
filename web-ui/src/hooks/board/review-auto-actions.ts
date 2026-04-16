import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";

export const AUTO_REVIEW_ACTION_DELAY_MS = 500;

export function isTaskAutoReviewEnabled(task: BoardCard): boolean {
	return task.autoReviewEnabled === true;
}

/**
 * Build a map of task ID → column ID from the board for quick lookups.
 */
export function buildColumnByTaskId(board: BoardData): Map<string, BoardColumnId> {
	const map = new Map<string, BoardColumnId>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			map.set(card.id, column.id);
		}
	}
	return map;
}

/**
 * Collect all cards currently in the review column that have auto-review enabled.
 */
export function getReviewCardsForAutomation(board: BoardData): BoardCard[] {
	const reviewColumn = board.columns.find((col) => col.id === "review");
	if (!reviewColumn) return [];
	return reviewColumn.cards.filter(isTaskAutoReviewEnabled);
}

/**
 * Check whether a task's resolved auto-review mode is "move_to_trash".
 */
export function isAutoTrashMode(task: BoardCard): boolean {
	return resolveTaskAutoReviewMode(task.autoReviewMode) === "move_to_trash";
}
