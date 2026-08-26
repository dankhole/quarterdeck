import { applyProjectBoardCommands } from "@runtime-board-commands";
import { runtimeProjectBoardCommandBatchEnvelopeSchema } from "@runtime-contract";
import { describe, expect, it } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import {
	addTaskDependency,
	addTaskToColumnWithResult,
	moveTaskToColumn,
	removeTask,
	updateTask,
} from "@/state/board-state";
import type { BoardCard } from "@/types";

import { applyPendingProjectBoardCommands, deriveProjectBoardCommands } from "./project-board-command-sync";

function applyDerived(
	before: ReturnType<typeof createInitialBoardData>,
	after: ReturnType<typeof createInitialBoardData>,
) {
	const commands = deriveProjectBoardCommands(before, after);
	return { commands, board: applyProjectBoardCommands(before, commands).board };
}

describe("project board command sync", () => {
	it("reproduces multi-task creation and final ordering", () => {
		const before = createInitialBoardData();
		const first = addTaskToColumnWithResult(before, "backlog", {
			prompt: "First",
			baseRef: "main",
			agentId: "codex",
			useWorktree: true,
		});
		const second = addTaskToColumnWithResult(first.board, "backlog", {
			prompt: "Second",
			baseRef: "main",
			agentId: "claude",
			useWorktree: false,
		});

		const result = applyDerived(before, second.board);

		expect(result.commands.filter((command) => command.kind === "create_task")).toHaveLength(2);
		expect(result.board).toEqual(second.board);
	});

	it("preserves Pi ownership when creating a durable backlog task", () => {
		const before = createInitialBoardData();
		const created = addTaskToColumnWithResult(before, "backlog", {
			prompt: "Use Pi",
			baseRef: "main",
			agentId: "pi",
			useWorktree: true,
		});

		const result = applyDerived(before, created.board);

		expect(result.commands).toContainEqual(expect.objectContaining({ kind: "create_task", agentId: "pi" }));
		expect(result.board).toEqual(created.board);
	});

	it("reproduces editable and runtime metadata patches", () => {
		const created = addTaskToColumnWithResult(createInitialBoardData(), "backlog", {
			prompt: "Original",
			baseRef: "main",
			agentId: "codex",
			useWorktree: true,
		});
		const edited = updateTask(created.board, created.task.id, {
			prompt: "Updated",
			baseRef: "develop",
			useWorktree: false,
		});
		const backlog = edited.board.columns.find((column) => column.id === "backlog");
		if (!backlog?.cards[0]) throw new Error("Missing test task.");
		backlog.cards[0] = {
			...backlog.cards[0],
			title: "Updated title",
			agentId: "claude",
			baseRefPinned: true,
			workingDirectory: "/tmp/task",
			branch: "feature/task",
			pinned: true,
			updatedAt: 500,
		};

		const result = applyDerived(created.board, edited.board);

		expect(result.commands.some((command) => command.kind === "update_task")).toBe(true);
		expect(result.commands.some((command) => command.kind === "patch_task")).toBe(true);
		expect(result.board).toEqual(edited.board);
	});

	it("reproduces moves, dependency cleanup, and deletion", () => {
		const first = addTaskToColumnWithResult(createInitialBoardData(), "backlog", {
			prompt: "First",
			baseRef: "main",
		});
		const second = addTaskToColumnWithResult(first.board, "backlog", {
			prompt: "Second",
			baseRef: "main",
		});
		const linked = addTaskDependency(second.board, first.task.id, second.task.id);
		if (!linked.added) throw new Error("Expected dependency.");
		const moved = moveTaskToColumn(linked.board, first.task.id, "in_progress", { insertAtTop: true });
		const deleted = removeTask(moved.board, first.task.id);

		const result = applyDerived(linked.board, deleted.board);

		expect(result.commands.some((command) => command.kind === "delete_tasks")).toBe(true);
		expect(result.board).toEqual(deleted.board);
	});

	it("overlays pending batches in issue order", () => {
		const before = createInitialBoardData();
		const created = addTaskToColumnWithResult(before, "backlog", { prompt: "Task", baseRef: "main" });
		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress", { insertAtTop: true });
		const createCommands = deriveProjectBoardCommands(before, created.board);
		const moveCommands = deriveProjectBoardCommands(created.board, moved.board);

		expect(applyPendingProjectBoardCommands(before, [createCommands, moveCommands])).toEqual(moved.board);
	});

	it("represents a large reorder as one bounded command", () => {
		const initial = createInitialBoardData();
		const cards: BoardCard[] = Array.from({ length: 600 }, (_, index) => ({
			id: `task-${index}`,
			title: `Task ${index}`,
			prompt: `Prompt ${index}`,
			baseRef: "main",
			createdAt: index,
			updatedAt: index,
		}));
		const before = {
			...initial,
			columns: initial.columns.map((column) => (column.id === "backlog" ? { ...column, cards } : column)),
		};
		const after = {
			...before,
			columns: before.columns.map((column) =>
				column.id === "backlog" ? { ...column, cards: [...cards].reverse() } : column,
			),
		};

		const result = applyDerived(before, after);

		expect(result.commands).toEqual([
			{
				kind: "reorder_column",
				columnId: "backlog",
				taskIds: after.columns[0]?.cards.map((card) => card.id),
			},
		]);
		expect(() =>
			runtimeProjectBoardCommandBatchEnvelopeSchema.parse({
				commandId: "browser:large-reorder",
				expectedRevision: 1,
				commands: result.commands,
			}),
		).not.toThrow();
		expect(result.board).toEqual(after);
	});
});
