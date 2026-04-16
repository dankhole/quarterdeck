import { afterEach, describe, expect, it, vi } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import { addTaskToColumn, normalizeBoardData } from "@/state/board-state";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("normalizeBoardData", () => {
	it("creates tasks when randomUUID is unavailable", () => {
		vi.stubGlobal("crypto", { randomUUID: undefined });

		const board = addTaskToColumn(createInitialBoardData(), "backlog", {
			prompt: "Task A",
			baseRef: "main",
		});
		const backlogCards = board.columns.find((column) => column.id === "backlog")?.cards ?? [];

		expect(backlogCards).toHaveLength(1);
		expect(backlogCards[0]?.id).toHaveLength(5);
	});

	it("preserves string branch", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [{ id: "a", prompt: "Task A", startInPlanMode: false, baseRef: "main", branch: "feat/foo" }],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "trash", cards: [] },
			],
		};
		const board = normalizeBoardData(rawBoard);
		expect(board).not.toBeNull();
		const card = board!.columns[0]?.cards[0];
		expect(card?.branch).toBe("feat/foo");
	});

	it("preserves null branch", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [{ id: "a", prompt: "Task A", startInPlanMode: false, baseRef: "main", branch: null }],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "trash", cards: [] },
			],
		};
		const board = normalizeBoardData(rawBoard);
		expect(board).not.toBeNull();
		const card = board!.columns[0]?.cards[0];
		expect(card?.branch).toBeNull();
	});

	it("defaults undefined for missing branch", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [{ id: "a", prompt: "Task A", startInPlanMode: false, baseRef: "main" }],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "trash", cards: [] },
			],
		};
		const board = normalizeBoardData(rawBoard);
		expect(board).not.toBeNull();
		const card = board!.columns[0]?.cards[0];
		expect(card?.branch).toBeUndefined();
	});

	it("rejects non-string branch", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [{ id: "a", prompt: "Task A", startInPlanMode: false, baseRef: "main", branch: 123 }],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "trash", cards: [] },
			],
		};
		const board = normalizeBoardData(rawBoard);
		expect(board).not.toBeNull();
		const card = board!.columns[0]?.cards[0];
		expect(card?.branch).toBeUndefined();
	});

	it("handles cards without branch field (regression test 30)", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [
						{ id: "a", prompt: "Old Card", startInPlanMode: false, baseRef: "main" },
						{ id: "b", prompt: "Card With Branch", startInPlanMode: false, baseRef: "main", branch: "feat/x" },
					],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "trash", cards: [] },
			],
		};
		const board = normalizeBoardData(rawBoard);
		expect(board).not.toBeNull();
		const cards = board!.columns[0]?.cards ?? [];
		expect(cards).toHaveLength(2);
		expect(cards[0]?.branch).toBeUndefined();
		expect(cards[1]?.branch).toBe("feat/x");
	});
});
