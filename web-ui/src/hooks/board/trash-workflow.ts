/**
 * Pure domain logic for the trash workflow (types, initial states, helpers).
 *
 * No React imports — types and functions here are plain TS. The companion
 * hook (`use-trash-workflow.ts`) handles React state, refs, and async
 * orchestration.
 */

import type { TaskTrashWarningViewModel } from "@/components/task-trash-warning-dialog";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrashWarningState {
	open: boolean;
	warning: TaskTrashWarningViewModel | null;
	card: BoardCard | null;
	fromColumnId: BoardColumnId | null;
	optimisticMoveApplied: boolean;
}

export interface HardDeleteDialogState {
	open: boolean;
	taskId: string | null;
	taskTitle: string | null;
}

// ---------------------------------------------------------------------------
// Initial states
// ---------------------------------------------------------------------------

export const INITIAL_TRASH_WARNING_STATE: TrashWarningState = {
	open: false,
	warning: null,
	card: null,
	fromColumnId: null,
	optimisticMoveApplied: false,
};

export const INITIAL_HARD_DELETE_DIALOG_STATE: HardDeleteDialogState = {
	open: false,
	taskId: null,
	taskTitle: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the list of task IDs currently in the trash column.
 */
export function findTrashTaskIds(board: BoardData): string[] {
	const trashColumn = board.columns.find((column) => column.id === "trash");
	return trashColumn ? trashColumn.cards.map((card) => card.id) : [];
}
