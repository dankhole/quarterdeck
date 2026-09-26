import type { BoardColumn, BoardColumnId } from "@/types";

export interface ProgrammaticCardMoveInFlight {
	taskId: string;
	fromColumnId: BoardColumnId;
	toColumnId: BoardColumnId;
	insertAtTop: boolean;
}

function isMatchingProgrammaticCardMove(
	taskId: string | null | undefined,
	fromColumnId: BoardColumnId,
	toColumnId: BoardColumnId,
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null,
): boolean {
	return (
		taskId !== null &&
		taskId !== undefined &&
		programmaticCardMoveInFlight?.taskId === taskId &&
		programmaticCardMoveInFlight.fromColumnId === fromColumnId &&
		programmaticCardMoveInFlight.toColumnId === toColumnId
	);
}

export function isAllowedCrossColumnCardMove(
	fromColumnId: BoardColumnId,
	toColumnId: BoardColumnId,
	options?: {
		taskId?: string | null;
		unstarted?: boolean;
		programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
	},
): boolean {
	if (fromColumnId === "review" && toColumnId === "in_progress" && options?.unstarted) {
		return true;
	}
	if (toColumnId === "trash" && fromColumnId !== "trash") {
		return true;
	}
	if (fromColumnId === "trash" && toColumnId === "review") {
		return true;
	}
	if (
		(fromColumnId === "in_progress" && toColumnId === "review") ||
		(fromColumnId === "review" && toColumnId === "in_progress")
	) {
		return isMatchingProgrammaticCardMove(
			options?.taskId,
			fromColumnId,
			toColumnId,
			options?.programmaticCardMoveInFlight,
		);
	}
	return false;
}

export function findCardColumnId(columns: ReadonlyArray<BoardColumn>, taskId: string): BoardColumnId | null {
	for (const column of columns) {
		if (column.cards.some((card) => card.id === taskId)) {
			return column.id;
		}
	}
	return null;
}

export function isCardDropDisabled(
	columnId: BoardColumnId,
	activeDragSourceColumnId: BoardColumnId | null,
	options?: {
		activeDragTaskId?: string | null;
		activeDragTaskUnstarted?: boolean;
		programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
	},
): boolean {
	if (!activeDragSourceColumnId) {
		return false;
	}
	if (columnId === "review" && activeDragSourceColumnId === "review") return false;
	if (columnId === "review") {
		return !isAllowedCrossColumnCardMove(activeDragSourceColumnId, columnId, {
			taskId: options?.activeDragTaskId,
			unstarted: options?.activeDragTaskUnstarted,
			programmaticCardMoveInFlight: options?.programmaticCardMoveInFlight,
		});
	}
	if (columnId === "in_progress") {
		if (activeDragSourceColumnId === "in_progress") {
			return false;
		}
		return !isAllowedCrossColumnCardMove(activeDragSourceColumnId, columnId, {
			taskId: options?.activeDragTaskId,
			unstarted: options?.activeDragTaskUnstarted,
			programmaticCardMoveInFlight: options?.programmaticCardMoveInFlight,
		});
	}
	if (columnId === "trash") {
		return activeDragSourceColumnId === "trash";
	}
	return false;
}
