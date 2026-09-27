import type { DropResult } from "@hello-pangea/dnd";
import { findCardColumnId, isAllowedCrossColumnCardMove, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type { BoardData } from "@/types";

/** Translate a spatial grid target to the existing board/lifecycle intent. Resolve by ID, never DOM order. */
export function resolveBoardGridDrop(
	board: BoardData,
	taskId: string,
	targetId: string,
	programmaticMove?: ProgrammaticCardMoveInFlight,
): DropResult | null {
	const from = findCardColumnId(board.columns, taskId);
	const to = board.columns.find((column) => column.id === targetId)?.id ?? findCardColumnId(board.columns, targetId);
	if (!from || !to) return null;
	const source = board.columns.find((column) => column.id === from)!;
	const target = board.columns.find((column) => column.id === to)!;
	const sourceIndex = source.cards.findIndex((card) => card.id === taskId);
	const card = source.cards[sourceIndex]!;
	if (
		from !== to &&
		!isAllowedCrossColumnCardMove(from, to, {
			taskId,
			unstarted: card.unstarted,
			programmaticCardMoveInFlight: programmaticMove,
		})
	)
		return null;
	const targetIndex = target.cards.findIndex((candidate) => candidate.id === targetId);
	return {
		draggableId: taskId,
		type: "CARD",
		reason: "DROP",
		mode: "FLUID",
		combine: null,
		source: { droppableId: from, index: sourceIndex },
		destination: {
			droppableId: to,
			index: programmaticMove?.insertAtTop ? 0 : targetIndex >= 0 ? targetIndex : target.cards.length,
		},
	};
}
