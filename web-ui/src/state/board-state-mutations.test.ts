import { describe, expect, it } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import {
	addTaskToColumn,
	disableTaskAutoReview,
	moveTaskToColumn,
	reconcileTaskBranch,
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

describe("disableTaskAutoReview", () => {
	it("disables auto-review settings for a task", () => {
		let board = createInitialBoardData();
		board = addTaskToColumn(board, "review", {
			prompt: "Task A",
			autoReviewEnabled: true,
			autoReviewMode: "move_to_trash",
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected review task to exist");
		}

		const disabled = disableTaskAutoReview(board, task.id);
		expect(disabled.updated).toBe(true);

		const updatedTask = disabled.board.columns.find((column) => column.id === "review")?.cards[0];
		expect(updatedTask?.autoReviewEnabled).toBe(false);
		expect(updatedTask?.autoReviewMode).toBe("move_to_trash");
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
