import type { BoardCard, BoardColumnId } from "@/types";

/**
 * Sorts column cards for display.
 * - Review: started tasks first, then unstarted tasks in insertion order.
 * - Trash: most-recently-trashed first.
 * - Other columns: pinned first, then most-recently-updated.
 */
export function sortColumnCards(cards: readonly BoardCard[], columnId: BoardColumnId): BoardCard[] {
	if (columnId === "trash") {
		return [...cards].sort((a, b) => b.updatedAt - a.updatedAt);
	}
	return [...cards].sort((a, b) => {
		if (columnId === "review" && Boolean(a.unstarted) !== Boolean(b.unstarted)) {
			return a.unstarted ? 1 : -1;
		}
		const aPinned = a.pinned ? 1 : 0;
		const bPinned = b.pinned ? 1 : 0;
		if (aPinned !== bPinned) return bPinned - aPinned;
		return columnId === "review" && a.unstarted ? 0 : b.updatedAt - a.updatedAt;
	});
}
