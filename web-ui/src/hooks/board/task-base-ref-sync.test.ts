import { describe, expect, it } from "vitest";

import { applyTaskBaseRefSelectionToBoard, applyTaskBaseRefUpdateToBoard } from "@/hooks/board/task-base-ref-sync";
import type { BoardCard, BoardData } from "@/types";

function createCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "task-1",
		title: "Task",
		prompt: "Do it",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createBoard(card: BoardCard = createCard()): BoardData {
	return {
		columns: [{ id: "in_progress", title: "In progress", cards: [card] }],
		dependencies: [],
	};
}

describe("applyTaskBaseRefUpdateToBoard", () => {
	it("applies inferred base-ref updates to unpinned cards", () => {
		const board = createBoard();
		const next = applyTaskBaseRefUpdateToBoard(board, { taskId: "task-1", baseRef: " develop " });

		expect(next).not.toBe(board);
		expect(next.columns[0]?.cards[0]?.baseRef).toBe("develop");
		expect(next.columns[0]?.cards[0]?.baseRefPinned).toBeUndefined();
	});

	it("formalizes empty updates as unresolved base refs", () => {
		const board = createBoard(createCard({ baseRef: "feature" }));
		const next = applyTaskBaseRefUpdateToBoard(board, { taskId: "task-1", baseRef: "" });

		expect(next.columns[0]?.cards[0]?.baseRef).toBe("");
		expect(next.columns[0]?.cards[0]?.baseRefPinned).toBeUndefined();
	});

	it("leaves pinned base refs under user control", () => {
		const board = createBoard(createCard({ baseRef: "release", baseRefPinned: true }));
		const next = applyTaskBaseRefUpdateToBoard(board, { taskId: "task-1", baseRef: "main" });

		expect(next).toBe(board);
		expect(next.columns[0]?.cards[0]?.baseRef).toBe("release");
	});
});

describe("applyTaskBaseRefSelectionToBoard", () => {
	it("stores manual selections as inferred refs unless pinned", () => {
		const board = createBoard(createCard({ baseRef: "" }));
		const next = applyTaskBaseRefSelectionToBoard(board, {
			taskId: "task-1",
			baseRef: " develop ",
			pinned: false,
		});

		expect(next.columns[0]?.cards[0]?.baseRef).toBe("develop");
		expect(next.columns[0]?.cards[0]?.baseRefPinned).toBeUndefined();
	});

	it("stores pinned manual selections as locked refs", () => {
		const board = createBoard(createCard({ baseRef: "main" }));
		const next = applyTaskBaseRefSelectionToBoard(board, {
			taskId: "task-1",
			baseRef: "release",
			pinned: true,
		});

		expect(next.columns[0]?.cards[0]?.baseRef).toBe("release");
		expect(next.columns[0]?.cards[0]?.baseRefPinned).toBe(true);
	});

	it("normalizes unresolved manual selections back to an unlocked unresolved state", () => {
		const board = createBoard(createCard({ baseRef: "main", baseRefPinned: true }));
		const next = applyTaskBaseRefSelectionToBoard(board, {
			taskId: "task-1",
			baseRef: "",
			pinned: true,
		});

		expect(next.columns[0]?.cards[0]?.baseRef).toBe("");
		expect(next.columns[0]?.cards[0]?.baseRefPinned).toBeUndefined();
	});
});
