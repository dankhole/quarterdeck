import type { Dispatch, SetStateAction } from "react";
import { useEffect } from "react";
import type { TaskBaseRefUpdate } from "@/runtime/use-runtime-state-stream";
import type { BoardData } from "@/types";

interface UseTaskBaseRefSyncInput {
	latestTaskBaseRefUpdate: TaskBaseRefUpdate | null;
	setBoard: Dispatch<SetStateAction<BoardData>>;
}

/**
 * Applies base ref updates received via WebSocket to the board.
 * Empty base refs are intentional: they mean the base is unresolved and the user
 * needs to pick one.
 * Skips cards with `baseRefPinned: true` — those are manually locked.
 */
export function useTaskBaseRefSync({ latestTaskBaseRefUpdate, setBoard }: UseTaskBaseRefSyncInput): void {
	useEffect(() => {
		if (!latestTaskBaseRefUpdate) {
			return;
		}
		const { taskId, baseRef } = latestTaskBaseRefUpdate;
		setBoard((current) => {
			for (const column of current.columns) {
				const cardIndex = column.cards.findIndex((c) => c.id === taskId);
				if (cardIndex === -1) {
					continue;
				}
				const card = column.cards[cardIndex]!;
				if (card.baseRef === baseRef) {
					return current;
				}
				if (card.baseRefPinned) {
					return current;
				}
				const updatedCards = [...column.cards];
				updatedCards[cardIndex] = { ...card, baseRef };
				return {
					...current,
					columns: current.columns.map((col) => (col.id === column.id ? { ...col, cards: updatedCards } : col)),
				};
			}
			return current;
		});
	}, [latestTaskBaseRefUpdate, setBoard]);
}
