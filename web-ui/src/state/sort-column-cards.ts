import type { BoardCard, BoardColumnId } from "@/types";

/**
 * Sorts column cards for display: pinned first, then by most-recently-updated.
 * Backlog columns preserve insertion order (no sorting applied).
 */
export function sortColumnCards(cards: readonly BoardCard[], columnId: BoardColumnId): BoardCard[] {
	if (columnId === "backlog") {
		return cards as BoardCard[];
	}
	return [...cards].sort((a, b) => {
		const aPinned = a.pinned ? 1 : 0;
		const bPinned = b.pinned ? 1 : 0;
		if (aPinned !== bPinned) return bPinned - aPinned;
		return b.updatedAt - a.updatedAt;
	});
}
