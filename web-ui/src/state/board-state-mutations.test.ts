import { describe, expect, it } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import {
	addTaskDependency,
	addTaskToColumn,
	clearColumnTasks,
	moveTaskToColumn,
	reconcileTaskBranch,
	removeTask,
	toggleTaskPinned,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "@/state/board-state";
import { createBacklogBoard, requireTaskId } from "@/state/board-state-test-helpers";

describe("moveTaskToColumn", () => {
	it("can insert moved cards at the top when requested", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedA = moveTaskToColumn(fixture.board, taskA, "in_progress");
		expect(movedA.moved).toBe(true);
		const movedB = moveTaskToColumn(movedA.board, taskB, "in_progress");
		expect(movedB.moved).toBe(true);
		const movedC = moveTaskToColumn(movedB.board, taskC, "in_progress", {
			insertAtTop: true,
		});
		expect(movedC.moved).toBe(true);
		const inProgressColumn = movedC.board.columns.find((column) => column.id === "in_progress");
		expect(inProgressColumn?.cards.map((card) => card.id)).toEqual([taskC, taskA, taskB]);
	});
});

describe("reconcileTaskBranch", () => {
	it("updates card when branch differs", () => {
		let board = addTaskToColumn(createInitialBoardData(), "backlog", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((c) => c.id === "backlog")!.cards[0]!.id;
		board = {
			...board,
			columns: board.columns.map((c) =>
				c.id === "backlog"
					? { ...c, cards: c.cards.map((card) => (card.id === taskId ? { ...card, branch: null } : card)) }
					: c,
			),
		};

		const result = reconcileTaskBranch(board, taskId, "feat/foo");
		expect(result.updated).toBe(true);
		const card = result.board.columns.find((c) => c.id === "backlog")!.cards.find((c) => c.id === taskId);
		expect(card?.branch).toBe("feat/foo");
	});

	it("no-ops when branch matches", () => {
		let board = addTaskToColumn(createInitialBoardData(), "backlog", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((c) => c.id === "backlog")!.cards[0]!.id;
		board = {
			...board,
			columns: board.columns.map((c) =>
				c.id === "backlog"
					? { ...c, cards: c.cards.map((card) => (card.id === taskId ? { ...card, branch: "feat/foo" } : card)) }
					: c,
			),
		};

		const result = reconcileTaskBranch(board, taskId, "feat/foo");
		expect(result.updated).toBe(false);
	});

	it("does NOT overwrite non-null with null (agent may be temporarily detached)", () => {
		let board = addTaskToColumn(createInitialBoardData(), "backlog", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((c) => c.id === "backlog")!.cards[0]!.id;
		board = {
			...board,
			columns: board.columns.map((c) =>
				c.id === "backlog"
					? { ...c, cards: c.cards.map((card) => (card.id === taskId ? { ...card, branch: "feat/foo" } : card)) }
					: c,
			),
		};

		const result = reconcileTaskBranch(board, taskId, null);
		expect(result.updated).toBe(false);
		const card = result.board.columns.find((c) => c.id === "backlog")!.cards.find((c) => c.id === taskId);
		expect(card?.branch).toBe("feat/foo");
	});

	it("updates card when branch changes", () => {
		let board = addTaskToColumn(createInitialBoardData(), "backlog", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((c) => c.id === "backlog")!.cards[0]!.id;
		board = {
			...board,
			columns: board.columns.map((c) =>
				c.id === "backlog"
					? { ...c, cards: c.cards.map((card) => (card.id === taskId ? { ...card, branch: "feat/old" } : card)) }
					: c,
			),
		};

		const result = reconcileTaskBranch(board, taskId, "feat/new");
		expect(result.updated).toBe(true);
		const card = result.board.columns.find((c) => c.id === "backlog")!.cards.find((c) => c.id === taskId);
		expect(card?.branch).toBe("feat/new");
	});

	it("updates card from undefined to string", () => {
		const board = addTaskToColumn(createInitialBoardData(), "backlog", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((c) => c.id === "backlog")!.cards[0]!.id;

		const result = reconcileTaskBranch(board, taskId, "feat/foo");
		expect(result.updated).toBe(true);
		const card = result.board.columns.find((c) => c.id === "backlog")!.cards.find((c) => c.id === taskId);
		expect(card?.branch).toBe("feat/foo");
	});

	it("no-ops when card has no existing branch and incoming is null (semantically equivalent)", () => {
		const board = addTaskToColumn(createInitialBoardData(), "backlog", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((c) => c.id === "backlog")!.cards[0]!.id;

		const result = reconcileTaskBranch(board, taskId, null);
		expect(result.updated).toBe(false);
		const card = result.board.columns.find((c) => c.id === "backlog")!.cards.find((c) => c.id === taskId);
		expect(card?.branch).toBeUndefined();
	});

	it("no-ops when incoming is undefined", () => {
		let board = addTaskToColumn(createInitialBoardData(), "backlog", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((c) => c.id === "backlog")!.cards[0]!.id;
		board = {
			...board,
			columns: board.columns.map((c) =>
				c.id === "backlog"
					? { ...c, cards: c.cards.map((card) => (card.id === taskId ? { ...card, branch: "feat/foo" } : card)) }
					: c,
			),
		};

		const result = reconcileTaskBranch(board, taskId, undefined);
		expect(result.updated).toBe(false);
		const card = result.board.columns.find((c) => c.id === "backlog")!.cards.find((c) => c.id === taskId);
		expect(card?.branch).toBe("feat/foo");
	});
});

describe("updateTask", () => {
	it("preserves branch field", () => {
		let board = addTaskToColumn(createInitialBoardData(), "backlog", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((c) => c.id === "backlog")!.cards[0]!.id;
		board = {
			...board,
			columns: board.columns.map((c) =>
				c.id === "backlog"
					? { ...c, cards: c.cards.map((card) => (card.id === taskId ? { ...card, branch: "feat/foo" } : card)) }
					: c,
			),
		};

		const result = updateTask(board, taskId, { prompt: "Updated prompt", baseRef: "develop" });
		expect(result.updated).toBe(true);
		const card = result.board.columns.find((c) => c.id === "backlog")!.cards.find((c) => c.id === taskId);
		expect(card?.branch).toBe("feat/foo");
		expect(card?.prompt).toBe("Updated prompt");
		expect(card?.baseRef).toBe("develop");
	});
});

describe("removeTask", () => {
	it("uses the runtime board deletion rules to remove linked dependencies", () => {
		const fixture = createBacklogBoard(["Task A", "Task B"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const linked = moveTaskToColumn(fixture.board, taskA, "review");
		expect(linked.moved).toBe(true);

		const withDependency = requireDependencyBoard(linked.board, taskA, taskB);
		const removed = removeTask(withDependency, taskA);

		expect(removed.removed).toBe(true);
		expect(removed.board.dependencies).toEqual([]);
		expect(removed.board.columns.some((column) => column.cards.some((card) => card.id === taskA))).toBe(false);
	});
});

describe("clearColumnTasks", () => {
	it("deletes all tasks in the target column via the runtime mutation rules", () => {
		const fixture = createBacklogBoard(["Task A", "Task B"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const moved = moveTaskToColumn(fixture.board, taskA, "trash");
		expect(moved.moved).toBe(true);
		const cleared = clearColumnTasks(moved.board, "trash");

		expect(cleared.clearedTaskIds).toEqual([taskA]);
		expect(cleared.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(cleared.board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id)).toContain(
			taskB,
		);
	});
});

describe("toggleTaskPinned", () => {
	it("toggles pinned state through the runtime task updater without changing other card fields", () => {
		let board = addTaskToColumn(createInitialBoardData(), "backlog", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((column) => column.id === "backlog")?.cards[0]?.id;
		if (!taskId) {
			throw new Error("Expected created task");
		}
		board = {
			...board,
			columns: board.columns.map((column) =>
				column.id === "backlog"
					? {
							...column,
							cards: column.cards.map((card) =>
								card.id === taskId
									? { ...card, branch: "feat/pinned", workingDirectory: "/tmp/worktree" }
									: card,
							),
						}
					: column,
			),
		};

		const pinned = toggleTaskPinned(board, taskId);
		expect(pinned.toggled).toBe(true);
		const pinnedCard = pinned.board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(pinnedCard?.pinned).toBe(true);
		expect(pinnedCard?.branch).toBe("feat/pinned");
		expect(pinnedCard?.workingDirectory).toBe("/tmp/worktree");

		const unpinned = toggleTaskPinned(pinned.board, taskId);
		expect(unpinned.toggled).toBe(true);
		const unpinnedCard = unpinned.board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(unpinnedCard?.pinned).toBeUndefined();
		expect(unpinnedCard?.branch).toBe("feat/pinned");
		expect(unpinnedCard?.workingDirectory).toBe("/tmp/worktree");
	});
});

describe("trashTaskAndGetReadyLinkedTaskIds", () => {
	it("preserves branch on trashed card", () => {
		let board = addTaskToColumn(createInitialBoardData(), "in_progress", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((c) => c.id === "in_progress")!.cards[0]!.id;
		board = {
			...board,
			columns: board.columns.map((c) =>
				c.id === "in_progress"
					? {
							...c,
							cards: c.cards.map((card) =>
								card.id === taskId
									? { ...card, branch: "feat/my-work", workingDirectory: "/tmp/worktree" }
									: card,
							),
						}
					: c,
			),
		};

		const result = trashTaskAndGetReadyLinkedTaskIds(board, taskId);
		expect(result.moved).toBe(true);
		const trashedCard = result.board.columns.find((c) => c.id === "trash")!.cards.find((c) => c.id === taskId);
		expect(trashedCard?.branch).toBe("feat/my-work");
		expect(trashedCard?.workingDirectory).toBeNull();
	});

	it("clears workingDirectory on trash (regression test 31)", () => {
		let board = addTaskToColumn(createInitialBoardData(), "in_progress", { prompt: "Task A", baseRef: "main" });
		const taskId = board.columns.find((c) => c.id === "in_progress")!.cards[0]!.id;
		board = {
			...board,
			columns: board.columns.map((c) =>
				c.id === "in_progress"
					? {
							...c,
							cards: c.cards.map((card) =>
								card.id === taskId ? { ...card, workingDirectory: "/tmp/worktree" } : card,
							),
						}
					: c,
			),
		};

		const result = trashTaskAndGetReadyLinkedTaskIds(board, taskId);
		expect(result.moved).toBe(true);
		const trashedCard = result.board.columns.find((c) => c.id === "trash")!.cards.find((c) => c.id === taskId);
		expect(trashedCard?.workingDirectory).toBeNull();
	});
});

function requireDependencyBoard(
	board: ReturnType<typeof createInitialBoardData>,
	fromTaskId: string,
	toTaskId: string,
) {
	const withDependency = addTaskDependency(board, fromTaskId, toTaskId);
	if (!withDependency.added) {
		throw new Error("Expected dependency to be created");
	}
	return withDependency.board;
}
