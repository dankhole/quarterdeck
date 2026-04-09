import type { BoardCard, BoardColumnId } from "@/types";

/**
 * Sorts column cards for display.
 * - Backlog: preserves insertion order (no sorting).
 * - Trash: oldest-trashed first (newest at bottom, like a chronological list).
 * - Other columns: pinned first, then most-recently-updated.
 */
export function sortColumnCards(cards: readonly BoardCard[], columnId: BoardColumnId): BoardCard[] {
	if (columnId === "backlog") {
		return cards as BoardCard[];
	}
	if (columnId === "trash") {
		return [...cards].sort((a, b) => a.updatedAt - b.updatedAt);
	}
	return [...cards].sort((a, b) => {
		const aPinned = a.pinned ? 1 : 0;
		const bPinned = b.pinned ? 1 : 0;
		if (aPinned !== bPinned) return bPinned - aPinned;
		return b.updatedAt - a.updatedAt;
	});
}
