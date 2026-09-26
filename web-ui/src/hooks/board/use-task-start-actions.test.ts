import { describe, expect, it } from "vitest";

import { getStartableUnstartedTaskIds } from "@/hooks/board/use-task-start-actions";
import type { BoardCard, BoardData, BoardDependency } from "@/types";

describe("getStartableUnstartedTaskIds", () => {
	function createCard(id: string, prompt = "Do something"): BoardCard {
		return {
			id,
			title: null,
			prompt,
			baseRef: "main",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
	}

	function createBoard({
		unstartedCards,
		dependencies = [],
		inProgressCards = [],
		reviewCards = [],
	}: {
		unstartedCards: BoardCard[];
		dependencies?: BoardDependency[];
		inProgressCards?: BoardCard[];
		reviewCards?: BoardCard[];
	}): BoardData {
		return {
			columns: [
				{
					id: "review",
					title: "Review",
					cards: [...reviewCards, ...unstartedCards.map((card) => ({ ...card, unstarted: true }))],
				},
				{ id: "in_progress", title: "In Progress", cards: inProgressCards },

				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies,
		};
	}

	it("returns all backlog task ids when there are no dependencies", () => {
		const board = createBoard({ unstartedCards: [createCard("task-1"), createCard("task-2"), createCard("task-3")] });
		expect(getStartableUnstartedTaskIds(board)).toEqual(["task-1", "task-2", "task-3"]);
	});

	it("starts only unstarted cards when Review also contains completed work", () => {
		const board = createBoard({ unstartedCards: [createCard("new")], reviewCards: [createCard("finished")] });
		expect(getStartableUnstartedTaskIds(board)).toEqual(["new"]);
	});

	it("returns empty array when backlog is empty", () => {
		const board = createBoard({ unstartedCards: [] });
		expect(getStartableUnstartedTaskIds(board)).toEqual([]);
	});

	it("excludes a parent task whose child is also in the backlog", () => {
		const board = createBoard({
			unstartedCards: [createCard("task-a"), createCard("task-b")],
			dependencies: [{ id: "dep-1", fromTaskId: "task-a", toTaskId: "task-b", createdAt: 1 }],
		});
		expect(getStartableUnstartedTaskIds(board)).toEqual(["task-b"]);
	});

	it("excludes a parent task whose child is in progress", () => {
		const board = createBoard({
			unstartedCards: [createCard("task-a")],
			dependencies: [{ id: "dep-1", fromTaskId: "task-a", toTaskId: "task-b", createdAt: 1 }],
			inProgressCards: [createCard("task-b")],
		});
		expect(getStartableUnstartedTaskIds(board)).toEqual([]);
	});
});
