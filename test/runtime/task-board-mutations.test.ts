import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core";
import {
	addTaskDependency,
	addTaskToColumn,
	canonicalizeTaskBoard,
	deleteTasksFromBoard,
	moveTaskToColumn,
	pruneOrphanSessionsForBroadcast,
	pruneOrphanSessionsForPersist,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../../src/core";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("canonicalizeTaskBoard", () => {
	it("drops invalid dependencies and reorients surviving links to the backlog endpoint", () => {
		const board = canonicalizeTaskBoard({
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "b",
							title: null,
							prompt: "Task B",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "a",
							title: null,
							prompt: "Task A",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [
				{ id: "dep-1", fromTaskId: "a", toTaskId: "b", createdAt: 1 },
				{ id: "dep-2", fromTaskId: "b", toTaskId: "a", createdAt: 2 },
				{ id: "dep-3", fromTaskId: "a", toTaskId: "missing", createdAt: 3 },
				{ id: "dep-4", fromTaskId: "a", toTaskId: "a", createdAt: 4 },
			],
		});

		expect(board.dependencies).toEqual([{ id: "dep-1", fromTaskId: "b", toTaskId: "a", createdAt: 1 }]);
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("branch persistence on cards", () => {
	it("trashTaskAndGetReadyLinkedTaskIds preserves branch on trashed card", () => {
		const created = addTaskToColumn(
			createBoard(),
			"in_progress",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		// Set branch directly on the card in board state
		const board: RuntimeBoardData = {
			...created.board,
			columns: created.board.columns.map((col) =>
				col.id === "in_progress"
					? {
							...col,
							cards: col.cards.map((card) =>
								card.id === created.task.id
									? { ...card, branch: "feat/my-work", workingDirectory: "/tmp/wt" }
									: card,
							),
						}
					: col,
			),
		};

		const trashed = trashTaskAndGetReadyLinkedTaskIds(board, created.task.id);
		const trashedCard = trashed.board.columns
			.find((c) => c.id === "trash")
			?.cards.find((c) => c.id === created.task.id);
		expect(trashedCard?.branch).toBe("feat/my-work");
		expect(trashedCard?.workingDirectory).toBeNull();
	});

	it("trashTaskAndGetReadyLinkedTaskIds clears workingDirectory but not branch", () => {
		const created = addTaskToColumn(
			createBoard(),
			"in_progress",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const board: RuntimeBoardData = {
			...created.board,
			columns: created.board.columns.map((col) =>
				col.id === "in_progress"
					? {
							...col,
							cards: col.cards.map((card) =>
								card.id === created.task.id
									? { ...card, branch: "feat/my-work", workingDirectory: "/tmp/wt" }
									: card,
							),
						}
					: col,
			),
		};

		const trashed = trashTaskAndGetReadyLinkedTaskIds(board, created.task.id);
		const trashedCard = trashed.board.columns
			.find((c) => c.id === "trash")
			?.cards.find((c) => c.id === created.task.id);
		expect(trashedCard?.workingDirectory).toBeNull();
		expect(trashedCard?.branch).toBe("feat/my-work");
	});

	it("addTaskToColumn sets branch from input", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main", branch: "feat/new" },
			() => "aaaaa111",
		);
		expect(created.task.branch).toBe("feat/new");
	});

	it("addTaskToColumn omits branch when not provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		expect(created.task.branch).toBeUndefined();
	});

	it("existing worktree creation without branch works unchanged (regression test 29)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		// When no branch is provided, the task should have no branch field
		expect(created.task.branch).toBeUndefined();
		expect(created.task.prompt).toBe("Task A");
		expect(created.task.baseRef).toBe("main");
	});

	it("workingDirectory still cleared on trash (regression test 31)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"in_progress",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const board: RuntimeBoardData = {
			...created.board,
			columns: created.board.columns.map((col) =>
				col.id === "in_progress"
					? {
							...col,
							cards: col.cards.map((card) =>
								card.id === created.task.id ? { ...card, workingDirectory: "/tmp/wt" } : card,
							),
						}
					: col,
			),
		};

		const trashed = trashTaskAndGetReadyLinkedTaskIds(board, created.task.id);
		const trashedCard = trashed.board.columns
			.find((c) => c.id === "trash")
			?.cards.find((c) => c.id === created.task.id);
		expect(trashedCard?.workingDirectory).toBeNull();
	});
});

describe("shutdown-coordinator moveTaskToTrash preserves branch", () => {
	it("preserves branch on trashed card via moveTaskToColumn spread", () => {
		const created = addTaskToColumn(
			createBoard(),
			"in_progress",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const board: RuntimeBoardData = {
			...created.board,
			columns: created.board.columns.map((col) =>
				col.id === "in_progress"
					? {
							...col,
							cards: col.cards.map((card) =>
								card.id === created.task.id ? { ...card, branch: "feat/shutdown-work" } : card,
							),
						}
					: col,
			),
		};

		// moveTaskToColumn uses the same ...task spread pattern as shutdown-coordinator
		const moved = moveTaskToColumn(board, created.task.id, "trash");
		expect(moved.moved).toBe(true);
		const trashedCard = moved.board.columns
			.find((c) => c.id === "trash")
			?.cards.find((c) => c.id === created.task.id);
		expect(trashedCard?.branch).toBe("feat/shutdown-work");
	});
});

describe("pruneOrphanSessionsForPersist", () => {
	function boardWithCards(cardIds: string[]): RuntimeBoardData {
		let board = createBoard();
		for (const id of cardIds) {
			const created = addTaskToColumn(board, "backlog", { prompt: id, baseRef: "main" }, () => `${id}1234`);
			board = created.board;
		}
		return board;
	}

	it("keeps summaries for cards currently on the board", () => {
		const board = boardWithCards(["aaaaa"]);
		const boardCardId = board.columns.find((c) => c.id === "backlog")?.cards[0]?.id ?? "";
		const sessions = {
			[boardCardId]: createTestTaskSessionSummary({ taskId: boardCardId }),
		};

		const pruned = pruneOrphanSessionsForPersist(sessions, board);

		expect(Object.keys(pruned)).toEqual([boardCardId]);
	});

	it("drops summaries for tasks no longer on the board", () => {
		const board = boardWithCards(["aaaaa"]);
		const sessions = {
			"orphan-task": createTestTaskSessionSummary({
				taskId: "orphan-task",
				state: "awaiting_review",
				reviewReason: "hook",
			}),
		};

		const pruned = pruneOrphanSessionsForPersist(sessions, board);

		expect(pruned).toEqual({});
	});

	it("drops live shell summaries that have no card (shells are ephemeral)", () => {
		const board = boardWithCards([]);
		const sessions = {
			__home_terminal__: createTestTaskSessionSummary({
				taskId: "__home_terminal__",
				state: "running",
				pid: 12345,
			}),
		};

		const pruned = pruneOrphanSessionsForPersist(sessions, board);

		expect(pruned).toEqual({});
	});
});

describe("pruneOrphanSessionsForBroadcast", () => {
	function boardWithCards(cardIds: string[]): RuntimeBoardData {
		let board = createBoard();
		for (const id of cardIds) {
			const created = addTaskToColumn(board, "backlog", { prompt: id, baseRef: "main" }, () => `${id}1234`);
			board = created.board;
		}
		return board;
	}

	it("keeps summaries for cards currently on the board", () => {
		const board = boardWithCards(["aaaaa"]);
		const boardCardId = board.columns.find((c) => c.id === "backlog")?.cards[0]?.id ?? "";
		const sessions = {
			[boardCardId]: createTestTaskSessionSummary({ taskId: boardCardId }),
		};

		const pruned = pruneOrphanSessionsForBroadcast(sessions, board);

		expect(Object.keys(pruned)).toEqual([boardCardId]);
	});

	it("keeps live shell summaries even when the board has no matching card", () => {
		const board = boardWithCards([]);
		const sessions = {
			__home_terminal__: createTestTaskSessionSummary({
				taskId: "__home_terminal__",
				state: "running",
				pid: 12345,
			}),
		};

		const pruned = pruneOrphanSessionsForBroadcast(sessions, board);

		expect(pruned).toEqual(sessions);
	});

	it("drops idle summaries for tasks no longer on the board", () => {
		const board = boardWithCards(["aaaaa"]);
		const sessions = {
			"orphan-task": createTestTaskSessionSummary({
				taskId: "orphan-task",
				state: "awaiting_review",
				reviewReason: "hook",
				pid: null,
			}),
		};

		const pruned = pruneOrphanSessionsForBroadcast(sessions, board);

		expect(pruned).toEqual({});
	});
});
