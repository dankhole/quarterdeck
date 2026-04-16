import { describe, expect, it } from "vitest";
import type { BoardData } from "@/types";
import { findTrashTaskIds, INITIAL_HARD_DELETE_DIALOG_STATE, INITIAL_TRASH_WARNING_STATE } from "./trash-workflow";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBoard(trashCardIds: string[]): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "backlog", cards: [] },
			{ id: "in_progress", title: "in_progress", cards: [] },
			{ id: "review", title: "review", cards: [] },
			{
				id: "trash",
				title: "trash",
				cards: trashCardIds.map((id) => ({
					id,
					title: `Task ${id}`,
					prompt: "",
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 1,
					updatedAt: 1,
				})),
			},
		],
		dependencies: [],
	};
}

// ---------------------------------------------------------------------------
// findTrashTaskIds
// ---------------------------------------------------------------------------

describe("findTrashTaskIds", () => {
	it("returns IDs of cards in the trash column", () => {
		expect(findTrashTaskIds(makeBoard(["t1", "t2", "t3"]))).toEqual(["t1", "t2", "t3"]);
	});

	it("returns empty array when trash is empty", () => {
		expect(findTrashTaskIds(makeBoard([]))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Initial states
// ---------------------------------------------------------------------------

describe("initial states", () => {
	it("INITIAL_TRASH_WARNING_STATE is closed with no card", () => {
		expect(INITIAL_TRASH_WARNING_STATE).toEqual({
			open: false,
			warning: null,
			card: null,
			fromColumnId: null,
			optimisticMoveApplied: false,
		});
	});

	it("INITIAL_HARD_DELETE_DIALOG_STATE is closed with no task", () => {
		expect(INITIAL_HARD_DELETE_DIALOG_STATE).toEqual({
			open: false,
			taskId: null,
			taskTitle: null,
		});
	});
});
