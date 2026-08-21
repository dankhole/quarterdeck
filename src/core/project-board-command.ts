import type { RuntimeBoardCard, RuntimeBoardData, RuntimeProjectBoardCommand, RuntimeTaskImage } from "./api-contract";
import type { RuntimeCreateTaskInput } from "./task-board-mutations";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	findCardInBoard,
	getTaskColumnId,
	moveTaskToColumn,
	patchTask,
	removeTaskDependency,
	reorderTaskInColumn,
	reorderTasksInColumn,
	updateTask,
} from "./task-board-mutations";

type RuntimeCreateTaskCommand = Extract<RuntimeProjectBoardCommand, { kind: "create_task" }>;

export interface RuntimeProjectBoardCommandResult {
	board: RuntimeBoardData;
	changed: boolean;
}

function areTaskImagesEqual(first: RuntimeTaskImage[] | undefined, second: RuntimeTaskImage[] | undefined): boolean {
	if (first === second) {
		return true;
	}
	if (!first || !second || first.length !== second.length) {
		return false;
	}
	return first.every((image, index) => {
		const candidate = second[index];
		return (
			candidate !== undefined &&
			image.id === candidate.id &&
			image.data === candidate.data &&
			image.mimeType === candidate.mimeType &&
			image.name === candidate.name
		);
	});
}

function areBoardCardsEqual(first: RuntimeBoardCard, second: RuntimeBoardCard): boolean {
	return (
		first.id === second.id &&
		first.title === second.title &&
		first.prompt === second.prompt &&
		areTaskImagesEqual(first.images, second.images) &&
		first.baseRef === second.baseRef &&
		first.baseRefPinned === second.baseRefPinned &&
		first.agentId === second.agentId &&
		first.useWorktree === second.useWorktree &&
		first.workingDirectory === second.workingDirectory &&
		first.branch === second.branch &&
		first.pinned === second.pinned &&
		first.createdAt === second.createdAt &&
		first.updatedAt === second.updatedAt
	);
}

function toCreateTaskInput(command: RuntimeCreateTaskCommand): RuntimeCreateTaskInput {
	return {
		taskId: command.taskId,
		title: command.title,
		prompt: command.prompt,
		images: command.images,
		baseRef: command.baseRef,
		agentId: command.agentId,
		useWorktree: command.useWorktree,
		branch: command.branch,
		pinned: command.pinned,
	};
}

/**
 * Applies one already-prepared command without IO or side effects.
 *
 * IDs and timestamps live in the command so applying the same value in tests,
 * optimistic clients, and the runtime produces the same board result.
 */
export function applyProjectBoardCommand(
	board: RuntimeBoardData,
	command: RuntimeProjectBoardCommand,
): RuntimeProjectBoardCommandResult {
	switch (command.kind) {
		case "create_task": {
			const existingTask = findCardInBoard(board, command.taskId);
			if (existingTask) {
				const expectedTask = addTaskToColumn(
					{
						...board,
						columns: board.columns.map((column) => ({ ...column, cards: [] })),
					},
					command.columnId,
					toCreateTaskInput(command),
					() => command.taskId,
					command.createdAt,
				).task;
				if (
					getTaskColumnId(board, command.taskId) === command.columnId &&
					areBoardCardsEqual(existingTask, expectedTask)
				) {
					return { board, changed: false };
				}
				throw new Error(`Task "${command.taskId}" already exists with different data.`);
			}
			const created = addTaskToColumn(
				board,
				command.columnId,
				toCreateTaskInput(command),
				() => command.taskId,
				command.createdAt,
			);
			return { board: created.board, changed: true };
		}
		case "update_task": {
			const existingTask = findCardInBoard(board, command.taskId);
			const updated = updateTask(
				board,
				command.taskId,
				{
					title: command.title,
					prompt: command.prompt,
					images: command.images,
					baseRef: command.baseRef,
					useWorktree: command.useWorktree,
					pinned: command.pinned,
				},
				command.updatedAt,
			);
			if (existingTask && updated.task && areBoardCardsEqual(existingTask, updated.task)) {
				return { board, changed: false };
			}
			return { board: updated.board, changed: updated.updated };
		}
		case "move_task": {
			if (command.sourceColumnId && getTaskColumnId(board, command.taskId) !== command.sourceColumnId) {
				return { board, changed: false };
			}
			const moved = moveTaskToColumn(board, command.taskId, command.targetColumnId, command.updatedAt, {
				targetIndex: command.targetIndex,
			});
			return { board: moved.board, changed: moved.moved };
		}
		case "reorder_task": {
			const reordered = reorderTaskInColumn(board, command.taskId, command.columnId, command.targetIndex);
			return { board: reordered.board, changed: reordered.reordered };
		}
		case "reorder_column": {
			const reordered = reorderTasksInColumn(board, command.columnId, command.taskIds);
			return { board: reordered.board, changed: reordered.reordered };
		}
		case "patch_task": {
			const existingTask = findCardInBoard(board, command.taskId);
			if (command.expectedTitle !== undefined && existingTask?.title !== command.expectedTitle) {
				return { board, changed: false };
			}
			const patched = patchTask(
				board,
				command.taskId,
				{
					title: command.title,
					agentId: command.agentId,
					baseRef: command.baseRef,
					baseRefPinned: command.baseRefPinned,
					useWorktree: command.useWorktree,
					workingDirectory: command.workingDirectory,
					branch: command.branch,
					pinned: command.pinned,
				},
				command.updatedAt,
			);
			return { board: patched.board, changed: patched.updated };
		}
		case "add_dependency": {
			const added = addTaskDependency(board, command.firstTaskId, command.secondTaskId, {
				dependencyId: command.dependencyId,
				createdAt: command.createdAt,
			});
			return { board: added.board, changed: added.added };
		}
		case "remove_dependency": {
			const removed = removeTaskDependency(board, command.dependencyId);
			return { board: removed.board, changed: removed.removed };
		}
		case "delete_tasks": {
			const deleted = deleteTasksFromBoard(board, command.taskIds);
			return { board: deleted.board, changed: deleted.deleted };
		}
	}
}

/** Applies a prepared command batch as one pure board transaction. */
export function applyProjectBoardCommands(
	board: RuntimeBoardData,
	commands: readonly RuntimeProjectBoardCommand[],
): RuntimeProjectBoardCommandResult {
	let nextBoard = board;
	let changed = false;
	for (const command of commands) {
		const result = applyProjectBoardCommand(nextBoard, command);
		nextBoard = result.board;
		changed ||= result.changed;
	}
	return { board: nextBoard, changed };
}
