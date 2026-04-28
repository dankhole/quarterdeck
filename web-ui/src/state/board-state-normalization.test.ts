import { afterEach, describe, expect, it, vi } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import { addTaskToColumn, normalizeBoardData } from "@/state/board-state";
import {
	parsePersistedBoardCard,
	parsePersistedBoardDependency,
	parsePersistedBoardPayload,
	parsePersistedTaskImages,
} from "@/state/board-state-parser";

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
					cards: [{ id: "a", prompt: "Task A", baseRef: "main", branch: "feat/foo" }],
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
					cards: [{ id: "a", prompt: "Task A", baseRef: "main", branch: null }],
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
					cards: [{ id: "a", prompt: "Task A", baseRef: "main" }],
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
					cards: [{ id: "a", prompt: "Task A", baseRef: "main", branch: 123 }],
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
						{ id: "a", prompt: "Old Card", baseRef: "main" },
						{ id: "b", prompt: "Card With Branch", baseRef: "main", branch: "feat/x" },
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

describe("board-state parser helpers", () => {
	it("parses persisted payload columns and ignores invalid column entries", () => {
		const parsed = parsePersistedBoardPayload({
			columns: [
				{ id: "backlog", cards: [{ prompt: "Task A", baseRef: "main" }] },
				{ id: "unknown", cards: [] },
				{ id: "review", cards: "nope" },
			],
			dependencies: [{ fromTaskId: "a", toTaskId: "b" }],
		});

		expect(parsed).toEqual({
			columns: [{ id: "backlog", cards: [{ prompt: "Task A", baseRef: "main" }] }],
			dependencies: [{ fromTaskId: "a", toTaskId: "b" }],
		});
	});

	it("parses cards with the same defaults as the legacy normalization path", () => {
		const legacyCardField = ["start", "In", "Plan", "Mode"].join("");
		const card = parsePersistedBoardCard(
			{
				prompt: "  Task A  ",
				baseRef: "  main  ",
				[legacyCardField]: true,
				images: [{ id: "img-1", data: "data", mimeType: "image/png" }, { id: 123 }],
				workingDirectory: null,
				branch: 123,
			},
			{ createTaskId: () => "task-1", now: 42 },
		);

		expect(card).toEqual({
			id: "task-1",
			title: null,
			prompt: "Task A",
			images: [{ id: "img-1", data: "data", mimeType: "image/png" }],
			baseRef: "main",
			useWorktree: undefined,
			workingDirectory: null,
			branch: undefined,
			pinned: undefined,
			createdAt: 42,
			updatedAt: 42,
		});
		expect(legacyCardField in (card as unknown as Record<string, unknown>)).toBe(false);
	});

	it("filters invalid persisted images and returns undefined when none survive", () => {
		expect(parsePersistedTaskImages([{ id: "img-1", data: "data", mimeType: "image/png" }, { id: 1 }])).toEqual([
			{ id: "img-1", data: "data", mimeType: "image/png" },
		]);
		expect(parsePersistedTaskImages([{ id: 1 }])).toBeUndefined();
	});

	it("drops invalid dependencies and generates ids for valid ones", () => {
		expect(
			parsePersistedBoardDependency(
				{ fromTaskId: " task-a ", toTaskId: "task-b" },
				{
					createDependencyId: () => "dep-1",
					now: 99,
				},
			),
		).toEqual({
			id: "dep-1",
			fromTaskId: "task-a",
			toTaskId: "task-b",
			createdAt: 99,
		});
		expect(
			parsePersistedBoardDependency(
				{ fromTaskId: "task-a", toTaskId: "missing" },
				{
					createDependencyId: () => "dep-2",
					now: 99,
				},
			),
		).toEqual({
			id: "dep-2",
			fromTaskId: "task-a",
			toTaskId: "missing",
			createdAt: 99,
		});
	});
});
