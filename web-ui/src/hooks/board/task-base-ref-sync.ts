import { resolveRuntimeTaskBaseRefState } from "@runtime-contract";
import type { BoardData } from "@/types";

export interface TaskBaseRefSyncUpdate {
	taskId: string;
	baseRef: string;
}

export interface TaskBaseRefSelectionUpdate extends TaskBaseRefSyncUpdate {
	pinned: boolean;
}

export function applyTaskBaseRefUpdateToBoard(board: BoardData, update: TaskBaseRefSyncUpdate): BoardData {
	const nextState = resolveRuntimeTaskBaseRefState({ baseRef: update.baseRef });

	for (const column of board.columns) {
		const cardIndex = column.cards.findIndex((card) => card.id === update.taskId);
		if (cardIndex === -1) {
			continue;
		}
		const card = column.cards[cardIndex]!;
		if (card.baseRefPinned) {
			return board;
		}
		const nextBaseRef = nextState.baseRef ?? "";
		if (card.baseRef === nextBaseRef) {
			return board;
		}
		const updatedCards = [...column.cards];
		updatedCards[cardIndex] = { ...card, baseRef: nextBaseRef, baseRefPinned: undefined };
		return {
			...board,
			columns: board.columns.map((candidate) =>
				candidate.id === column.id ? { ...candidate, cards: updatedCards } : candidate,
			),
		};
	}

	return board;
}

export function applyTaskBaseRefSelectionToBoard(board: BoardData, update: TaskBaseRefSelectionUpdate): BoardData {
	const nextState = resolveRuntimeTaskBaseRefState({ baseRef: update.baseRef, baseRefPinned: update.pinned });

	for (const column of board.columns) {
		const cardIndex = column.cards.findIndex((card) => card.id === update.taskId);
		if (cardIndex === -1) {
			continue;
		}
		const card = column.cards[cardIndex]!;
		const nextBaseRef = nextState.baseRef ?? "";
		const nextPinned = nextState.kind === "pinned" ? true : undefined;
		if (card.baseRef === nextBaseRef && card.baseRefPinned === nextPinned) {
			return board;
		}
		const updatedCards = [...column.cards];
		updatedCards[cardIndex] = { ...card, baseRef: nextBaseRef, baseRefPinned: nextPinned };
		return {
			...board,
			columns: board.columns.map((candidate) =>
				candidate.id === column.id ? { ...candidate, cards: updatedCards } : candidate,
			),
		};
	}

	return board;
}
