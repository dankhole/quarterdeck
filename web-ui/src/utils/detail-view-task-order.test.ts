import { describe, expect, it } from "vitest";
import type { BoardCard, BoardData } from "@/types";
import { getNextDetailTaskIdAfterTrashMove, isDetailViewColumnId } from "@/utils/detail-view-task-order";

function card(id: string, unstarted = false): BoardCard {
	return { id, title: null, prompt: "", baseRef: "main", createdAt: 1, updatedAt: 1, unstarted };
}

function board(inProgress: BoardCard[], review: BoardCard[]): BoardData {
	return {
		columns: [
			{ id: "in_progress", title: "In Progress", cards: inProgress },
			{ id: "review", title: "Review", cards: review },
			{ id: "trash", title: "Trash", cards: [card("trashed")] },
		],
		dependencies: [],
	};
}

describe("isDetailViewColumnId", () => {
	it("returns true only for in-progress and review columns", () => {
		expect(isDetailViewColumnId("in_progress")).toBe(true);
		expect(isDetailViewColumnId("review")).toBe(true);
		expect(isDetailViewColumnId("trash")).toBe(false);
	});
});

describe("getNextDetailTaskIdAfterTrashMove", () => {
	it("prefers the next detail task when available", () => {
		expect(getNextDetailTaskIdAfterTrashMove(board([card("i1"), card("i2")], [card("r1")]), "i1")).toBe("i2");
	});

	it("falls back to previous detail task when removing the last detail task", () => {
		expect(getNextDetailTaskIdAfterTrashMove(board([card("i1")], [card("r1")]), "r1")).toBe("i1");
	});

	it("skips unstarted Review cards when choosing the next task", () => {
		expect(getNextDetailTaskIdAfterTrashMove(board([card("i1")], [card("u1", true), card("r1")]), "i1")).toBe("r1");
	});

	it("returns the first started task when the target is unstarted or trashed", () => {
		const data = board([card("i1")], [card("u1", true), card("r1")]);
		expect(getNextDetailTaskIdAfterTrashMove(data, "u1")).toBe("i1");
		expect(getNextDetailTaskIdAfterTrashMove(data, "trashed")).toBe("i1");
	});

	it("returns null when only unstarted or trashed tasks remain", () => {
		expect(getNextDetailTaskIdAfterTrashMove(board([], [card("u1", true)]), "u1")).toBeNull();
	});
});
