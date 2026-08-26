import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeProjectBoardCommand } from "../../src/core";
import {
	applyProjectBoardCommand,
	runtimeProjectBoardCommandSchema,
	runtimeTaskLifecycleCommandSchema,
} from "../../src/core";

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

function createTaskCommand(taskId: string, prompt: string, createdAt: number): RuntimeProjectBoardCommand {
	return {
		kind: "create_task",
		columnId: "backlog",
		taskId,
		prompt,
		baseRef: "main",
		agentId: "codex",
		useWorktree: true,
		createdAt,
	};
}

describe("applyProjectBoardCommand", () => {
	it("creates tasks with command-owned identity and timestamps", () => {
		const command = createTaskCommand("task-a", "  Ship it  ", 100);
		const result = applyProjectBoardCommand(createBoard(), command);
		const replayed = applyProjectBoardCommand(result.board, command);

		expect(result.changed).toBe(true);
		expect(result.board.columns[0]?.cards).toEqual([
			{
				id: "task-a",
				title: null,
				prompt: "Ship it",
				baseRef: "main",
				agentId: "codex",
				useWorktree: true,
				createdAt: 100,
				updatedAt: 100,
			},
		]);
		expect(replayed.changed).toBe(false);
		expect(replayed.board).toBe(result.board);
	});

	it("applies update, move, dependency, and delete commands through shared reducers", () => {
		const first = applyProjectBoardCommand(createBoard(), createTaskCommand("task-a", "Task A", 100));
		const second = applyProjectBoardCommand(first.board, createTaskCommand("task-b", "Task B", 110));
		const moved = applyProjectBoardCommand(second.board, {
			kind: "move_task",
			taskId: "task-b",
			targetColumnId: "review",
			updatedAt: 120,
		});
		const linked = applyProjectBoardCommand(moved.board, {
			kind: "add_dependency",
			firstTaskId: "task-a",
			secondTaskId: "task-b",
			dependencyId: "dependency-a",
			createdAt: 130,
		});
		const updateCommand: RuntimeProjectBoardCommand = {
			kind: "update_task",
			taskId: "task-a",
			title: "Task A title",
			prompt: "Updated Task A",
			baseRef: "develop",
			useWorktree: false,
			pinned: true,
			updatedAt: 140,
		};
		const updated = applyProjectBoardCommand(linked.board, updateCommand);
		const replayedUpdate = applyProjectBoardCommand(updated.board, updateCommand);
		const deleted = applyProjectBoardCommand(updated.board, {
			kind: "delete_tasks",
			taskIds: ["task-b"],
		});

		expect(moved.changed).toBe(true);
		expect(moved.board.columns.find((column) => column.id === "review")?.cards[0]?.updatedAt).toBe(120);
		expect(linked.board.dependencies).toEqual([
			{
				id: "dependency-a",
				fromTaskId: "task-a",
				toTaskId: "task-b",
				createdAt: 130,
			},
		]);
		expect(updated.board.columns[0]?.cards[0]).toMatchObject({
			id: "task-a",
			title: "Task A title",
			prompt: "Updated Task A",
			baseRef: "develop",
			useWorktree: false,
			pinned: true,
			updatedAt: 140,
		});
		expect(replayedUpdate.changed).toBe(false);
		expect(replayedUpdate.board).toBe(updated.board);
		expect(deleted.changed).toBe(true);
		expect(deleted.board.dependencies).toEqual([]);
		expect(deleted.board.columns.flatMap((column) => column.cards).map((card) => card.id)).toEqual(["task-a"]);
	});

	it("does not report missing-task commands as changes", () => {
		const board = createBoard();
		const moved = applyProjectBoardCommand(board, {
			kind: "move_task",
			taskId: "missing",
			targetColumnId: "review",
			updatedAt: 100,
		});

		expect(moved).toEqual({ board, changed: false });
	});

	it("reorders cards and patches runtime-owned metadata deterministically", () => {
		const first = applyProjectBoardCommand(createBoard(), createTaskCommand("task-a", "Task A", 100));
		const second = applyProjectBoardCommand(first.board, createTaskCommand("task-b", "Task B", 110));
		const third = applyProjectBoardCommand(second.board, createTaskCommand("task-c", "Task C", 120));

		const reordered = applyProjectBoardCommand(third.board, {
			kind: "reorder_task",
			taskId: "task-a",
			columnId: "backlog",
			targetIndex: 0,
		});
		const patched = applyProjectBoardCommand(reordered.board, {
			kind: "patch_task",
			taskId: "task-a",
			branch: "feature/task-a",
			workingDirectory: "/tmp/task-a",
			baseRefPinned: true,
			updatedAt: 130,
		});
		const repeatedPatch = applyProjectBoardCommand(patched.board, {
			kind: "patch_task",
			taskId: "task-a",
			branch: "feature/task-a",
			workingDirectory: "/tmp/task-a",
			baseRefPinned: true,
			updatedAt: 140,
		});

		expect(reordered.changed).toBe(true);
		expect(reordered.board.columns[0]?.cards.map((card) => card.id)).toEqual(["task-a", "task-c", "task-b"]);
		expect(patched.changed).toBe(true);
		expect(patched.board.columns[0]?.cards[0]).toMatchObject({
			id: "task-a",
			branch: "feature/task-a",
			workingDirectory: "/tmp/task-a",
			baseRefPinned: true,
			updatedAt: 130,
		});
		expect(repeatedPatch.changed).toBe(false);
		expect(repeatedPatch.board).toBe(patched.board);
	});

	it("reorders a whole column atomically and ignores stale membership", () => {
		const first = applyProjectBoardCommand(createBoard(), createTaskCommand("task-a", "Task A", 100));
		const second = applyProjectBoardCommand(first.board, createTaskCommand("task-b", "Task B", 110));
		const reordered = applyProjectBoardCommand(second.board, {
			kind: "reorder_column",
			columnId: "backlog",
			taskIds: ["task-a", "task-b"],
		});

		expect(reordered.changed).toBe(true);
		expect(reordered.board.columns[0]?.cards.map((card) => card.id)).toEqual(["task-a", "task-b"]);
		expect(
			applyProjectBoardCommand(reordered.board, {
				kind: "reorder_column",
				columnId: "backlog",
				taskIds: ["task-a"],
			}),
		).toEqual({ board: reordered.board, changed: false });
	});

	it("inserts cross-column moves at the requested position", () => {
		const first = applyProjectBoardCommand(createBoard(), createTaskCommand("task-a", "Task A", 100));
		const second = applyProjectBoardCommand(first.board, createTaskCommand("task-b", "Task B", 110));
		const movedA = applyProjectBoardCommand(second.board, {
			kind: "move_task",
			taskId: "task-a",
			targetColumnId: "review",
			updatedAt: 120,
		});
		const movedB = applyProjectBoardCommand(movedA.board, {
			kind: "move_task",
			taskId: "task-b",
			targetColumnId: "review",
			targetIndex: 0,
			updatedAt: 130,
		});

		expect(movedB.board.columns.find((column) => column.id === "review")?.cards.map((card) => card.id)).toEqual([
			"task-b",
			"task-a",
		]);
	});

	it("does not move a task when the source-column precondition is stale", () => {
		const created = applyProjectBoardCommand(createBoard(), createTaskCommand("task-a", "Task A", 100));
		const result = applyProjectBoardCommand(created.board, {
			kind: "move_task",
			taskId: "task-a",
			sourceColumnId: "review",
			targetColumnId: "in_progress",
			updatedAt: 120,
		});

		expect(result).toEqual({ board: created.board, changed: false });
	});
});

describe("runtimeProjectBoardCommandSchema", () => {
	it("accepts every maintained agent for new commands", () => {
		expect(runtimeProjectBoardCommandSchema.safeParse(createTaskCommand("task-a", "Task A", 100)).success).toBe(true);
		expect(
			runtimeProjectBoardCommandSchema.safeParse({
				...createTaskCommand("task-a", "Task A", 100),
				agentId: "pi",
			}).success,
		).toBe(true);
	});
});

describe("runtimeTaskLifecycleCommandSchema", () => {
	it("accepts Pi for create-and-start", () => {
		expect(
			runtimeTaskLifecycleCommandSchema.safeParse({
				kind: "create_and_start",
				operationId: "create-and-start-pi",
				expectedRevision: 0,
				startedAt: 100,
				task: {
					taskId: "task-pi",
					prompt: "Use Pi",
					baseRef: "main",
					agentId: "pi",
					createdAt: 100,
				},
			}).success,
		).toBe(true);
	});
});
