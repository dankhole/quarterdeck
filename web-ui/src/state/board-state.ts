import type { DropResult } from "@hello-pangea/dnd";
import { createShortTaskId } from "@runtime-task-id";
import * as runtimeTaskState from "@runtime-task-state";

import { createInitialBoardData } from "@/data/board-data";
import {
	parsePersistedBoardCard,
	parsePersistedBoardDependency,
	parsePersistedBoardPayload,
} from "@/state/board-state-parser";
import { isAllowedCrossColumnCardMove, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import {
	type BoardCard,
	type BoardColumn,
	type BoardColumnId,
	type BoardData,
	type BoardDependency,
	type CardSelection,
	DEFAULT_TASK_AUTO_REVIEW_MODE,
	resolveTaskAutoReviewMode,
	type TaskAutoReviewMode,
	type TaskImage,
} from "@/types";

export interface TaskDraft {
	prompt: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: TaskAutoReviewMode;
	images?: TaskImage[];
	baseRef: string;
	useWorktree?: boolean;
	branchName?: string;
}

export interface TaskMoveEvent {
	taskId: string;
	fromColumnId: BoardColumnId;
	toColumnId: BoardColumnId;
}

function reorder<T>(list: T[], startIndex: number, endIndex: number): T[] {
	const result = Array.from(list);
	const [removed] = result.splice(startIndex, 1);
	if (removed !== undefined) {
		result.splice(endIndex, 0, removed);
	}
	return result;
}

function updateTaskTimestamp(task: BoardCard): BoardCard {
	return {
		...task,
		updatedAt: Date.now(),
	};
}

function withUpdatedColumns(board: BoardData, columns: BoardColumn[]): BoardData {
	return {
		...board,
		columns,
	};
}

function updateCardInBoard(
	board: BoardData,
	taskId: string,
	updater: (card: BoardCard) => BoardCard | null,
): { columns: BoardColumn[]; updated: boolean } {
	let updated = false;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== taskId) return card;
			const result = updater(card);
			if (result === null) return card;
			columnUpdated = true;
			updated = true;
			return result;
		});
		return columnUpdated ? { ...column, cards } : column;
	});
	return { columns, updated };
}

function createBrowserUuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function createDependencyId(): string {
	return createBrowserUuid().replaceAll("-", "").slice(0, 8);
}

function createRuntimeTaskUpdateInput(
	card: BoardCard,
	overrides: Partial<runtimeTaskState.RuntimeUpdateTaskInput>,
): runtimeTaskState.RuntimeUpdateTaskInput {
	return {
		title: overrides.title === undefined ? card.title : overrides.title,
		prompt: overrides.prompt === undefined ? card.prompt : overrides.prompt,
		startInPlanMode: overrides.startInPlanMode === undefined ? card.startInPlanMode : overrides.startInPlanMode,
		autoReviewEnabled:
			overrides.autoReviewEnabled === undefined ? card.autoReviewEnabled : overrides.autoReviewEnabled,
		autoReviewMode: overrides.autoReviewMode === undefined ? card.autoReviewMode : overrides.autoReviewMode,
		images: overrides.images === undefined ? card.images : overrides.images,
		baseRef: overrides.baseRef === undefined ? card.baseRef : overrides.baseRef,
		useWorktree: overrides.useWorktree === undefined ? card.useWorktree : overrides.useWorktree,
		pinned: overrides.pinned === undefined ? card.pinned : overrides.pinned,
	};
}

export function normalizeBoardData(rawBoard: unknown): BoardData | null {
	const parsedBoard = parsePersistedBoardPayload(rawBoard);
	if (!parsedBoard) {
		return null;
	}

	const initial = createInitialBoardData();
	const normalizedColumns = initial.columns.map((column) => ({ ...column, cards: [] as BoardCard[] }));
	const columnById = new Map(normalizedColumns.map((column) => [column.id, column]));

	for (const parsedColumn of parsedBoard.columns) {
		const normalizedColumn = columnById.get(parsedColumn.id);
		if (!normalizedColumn) {
			continue;
		}
		for (const rawCard of parsedColumn.cards) {
			const card = parsePersistedBoardCard(rawCard, {
				createTaskId: () => createShortTaskId(createBrowserUuid),
			});
			if (card) {
				normalizedColumn.cards.push(card);
			}
		}
	}

	const normalizedDependencies: BoardDependency[] = [];
	for (const rawDependency of parsedBoard.dependencies) {
		const dependency = parsePersistedBoardDependency(rawDependency, {
			createDependencyId,
		});
		if (!dependency) {
			continue;
		}
		normalizedDependencies.push(dependency);
	}

	return runtimeTaskState.canonicalizeTaskBoard({
		columns: normalizedColumns,
		dependencies: normalizedDependencies,
	});
}

export function addTaskToColumn(board: BoardData, columnId: BoardColumnId, draft: TaskDraft): BoardData {
	const prompt = draft.prompt.trim();
	if (!prompt) {
		return board;
	}
	return addTaskToColumnWithResult(board, columnId, draft).board;
}

export function addTaskToColumnWithResult(
	board: BoardData,
	columnId: BoardColumnId,
	draft: TaskDraft,
): { board: BoardData; task: BoardCard } {
	const prompt = draft.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt is required.");
	}
	const result = runtimeTaskState.addTaskToColumn(
		board,
		columnId,
		{
			prompt,
			startInPlanMode: draft.startInPlanMode,
			autoReviewEnabled: draft.autoReviewEnabled,
			autoReviewMode: draft.autoReviewMode,
			images: draft.images,
			baseRef: draft.baseRef,
			useWorktree: draft.useWorktree,
			branch: draft.branchName,
		},
		createBrowserUuid,
	);
	return {
		board: result.board,
		task: result.task,
	};
}

export interface AddTaskDependencyResult {
	board: BoardData;
	added: boolean;
	reason?: NonNullable<runtimeTaskState.RuntimeAddTaskDependencyResult["reason"]>;
	dependency?: BoardDependency;
}

export function addTaskDependency(board: BoardData, fromTaskId: string, toTaskId: string): AddTaskDependencyResult {
	return runtimeTaskState.addTaskDependency(board, fromTaskId, toTaskId);
}

export function canCreateTaskDependency(board: BoardData, fromTaskId: string, toTaskId: string): boolean {
	return runtimeTaskState.canAddTaskDependency(board, fromTaskId, toTaskId);
}

export function removeTaskDependency(board: BoardData, dependencyId: string): { board: BoardData; removed: boolean } {
	return runtimeTaskState.removeTaskDependency(board, dependencyId);
}

export function getReadyLinkedTaskIdsForTaskInTrash(board: BoardData, taskId: string): string[] {
	return runtimeTaskState.getReadyLinkedTaskIdsForTaskInTrash(board, taskId);
}

export function trashTaskAndGetReadyLinkedTaskIds(
	board: BoardData,
	taskId: string,
): { board: BoardData; moved: boolean; readyTaskIds: string[] } {
	return runtimeTaskState.trashTaskAndGetReadyLinkedTaskIds(board, taskId);
}

export function applyDragResult(
	board: BoardData,
	result: DropResult,
	options?: { programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null },
): { board: BoardData; moveEvent?: TaskMoveEvent } {
	const { source, destination, type } = result;

	if (!destination) {
		return { board };
	}

	if (source.droppableId === destination.droppableId && source.index === destination.index) {
		return { board };
	}

	if (type === "COLUMN") {
		return { board };
	}

	const sourceColumnIndex = board.columns.findIndex((column) => column.id === source.droppableId);
	const destinationColumnIndex = board.columns.findIndex((column) => column.id === destination.droppableId);
	const sourceColumn = board.columns[sourceColumnIndex];
	const destinationColumn = board.columns[destinationColumnIndex];

	if (!sourceColumn || !destinationColumn) {
		return { board };
	}

	if (sourceColumn.id === destinationColumn.id) {
		const movedCards = reorder(sourceColumn.cards, source.index, destination.index);
		const columns = Array.from(board.columns);
		columns[sourceColumnIndex] = {
			...sourceColumn,
			cards: movedCards,
		};
		return { board: withUpdatedColumns(board, columns) };
	}

	const isAllowedCrossColumnMove = isAllowedCrossColumnCardMove(sourceColumn.id, destinationColumn.id, {
		taskId: result.draggableId,
		programmaticCardMoveInFlight: options?.programmaticCardMoveInFlight,
	});
	if (!isAllowedCrossColumnMove) {
		return { board };
	}

	const sourceCards = Array.from(sourceColumn.cards);
	const cardIndex = sourceCards.findIndex((card) => card.id === result.draggableId);
	if (cardIndex === -1) {
		return { board };
	}
	const movedCard = sourceCards.splice(cardIndex, 1)[0];
	if (!movedCard) {
		return { board };
	}

	const destinationCards = Array.from(destinationColumn.cards);
	const destinationInsertIndex = options?.programmaticCardMoveInFlight?.insertAtTop ? 0 : destination.index;
	destinationCards.splice(destinationInsertIndex, 0, updateTaskTimestamp(movedCard));

	const columns = Array.from(board.columns);
	columns[sourceColumnIndex] = {
		...sourceColumn,
		cards: sourceCards,
	};
	columns[destinationColumnIndex] = {
		...destinationColumn,
		cards: destinationCards,
	};

	return {
		board: runtimeTaskState.updateTaskDependencies(withUpdatedColumns(board, columns)),
		moveEvent: {
			taskId: movedCard.id,
			fromColumnId: sourceColumn.id,
			toColumnId: destinationColumn.id,
		},
	};
}
export function moveTaskToColumn(
	board: BoardData,
	taskId: string,
	targetColumnId: BoardColumnId,
	options?: { insertAtTop?: boolean },
): { board: BoardData; moved: boolean } {
	const moved = runtimeTaskState.moveTaskToColumn(board, taskId, targetColumnId);
	if (!moved.moved || !options?.insertAtTop) {
		return {
			board: moved.moved ? moved.board : board,
			moved: moved.moved,
		};
	}
	const targetColumnIndex = moved.board.columns.findIndex((column) => column.id === targetColumnId);
	const targetColumn = moved.board.columns[targetColumnIndex];
	if (!targetColumn) {
		return {
			board: moved.board,
			moved: moved.moved,
		};
	}
	const movedTaskIndex = targetColumn.cards.findIndex((card) => card.id === taskId);
	if (movedTaskIndex <= 0) {
		return {
			board: moved.board,
			moved: moved.moved,
		};
	}
	const targetCards = Array.from(targetColumn.cards);
	const [movedTask] = targetCards.splice(movedTaskIndex, 1);
	if (!movedTask) {
		return {
			board: moved.board,
			moved: moved.moved,
		};
	}
	targetCards.unshift(movedTask);
	const columns = Array.from(moved.board.columns);
	columns[targetColumnIndex] = {
		...targetColumn,
		cards: targetCards,
	};
	return {
		board: withUpdatedColumns(moved.board, columns),
		moved: moved.moved,
	};
}

export function updateTask(board: BoardData, taskId: string, draft: TaskDraft): { board: BoardData; updated: boolean } {
	const prompt = draft.prompt.trim();
	if (!prompt) {
		return { board, updated: false };
	}
	const baseRef = draft.baseRef.trim();
	if (!baseRef) {
		return { board, updated: false };
	}

	const selection = findCardSelection(board, taskId);
	if (!selection) {
		return { board, updated: false };
	}

	const updated = runtimeTaskState.updateTask(
		board,
		taskId,
		createRuntimeTaskUpdateInput(selection.card, {
			prompt,
			startInPlanMode: Boolean(draft.startInPlanMode),
			autoReviewEnabled: Boolean(draft.autoReviewEnabled),
			autoReviewMode: resolveTaskAutoReviewMode(draft.autoReviewMode ?? DEFAULT_TASK_AUTO_REVIEW_MODE),
			images: draft.images,
			baseRef,
			useWorktree: draft.useWorktree ?? selection.card.useWorktree,
		}),
	);
	return { board: updated.board, updated: updated.updated };
}

export function disableTaskAutoReview(board: BoardData, taskId: string): { board: BoardData; updated: boolean } {
	const selection = findCardSelection(board, taskId);
	if (!selection) {
		return { board, updated: false };
	}

	return updateTask(board, taskId, {
		prompt: selection.card.prompt,
		startInPlanMode: selection.card.startInPlanMode,
		autoReviewEnabled: false,
		autoReviewMode: DEFAULT_TASK_AUTO_REVIEW_MODE,
		images: selection.card.images,
		baseRef: selection.card.baseRef,
		useWorktree: selection.card.useWorktree,
	});
}

export function reconcileTaskWorkingDirectory(
	board: BoardData,
	taskId: string,
	metadataPath: string,
	projectPath: string | null,
): { board: BoardData; updated: boolean } {
	const isWorktree = projectPath ? metadataPath !== projectPath : undefined;
	const { columns, updated } = updateCardInBoard(board, taskId, (card) => {
		if (card.workingDirectory === metadataPath && (isWorktree === undefined || card.useWorktree === isWorktree)) {
			return null;
		}
		return {
			...card,
			workingDirectory: metadataPath,
			useWorktree: isWorktree ?? card.useWorktree,
			updatedAt: Date.now(),
		};
	});
	if (!updated) {
		return { board, updated: false };
	}
	return { board: withUpdatedColumns(board, columns), updated: true };
}

export function reconcileTaskBranch(
	board: BoardData,
	taskId: string,
	branch: string | null | undefined,
): { board: BoardData; updated: boolean } {
	// Skip when no metadata is available (undefined). Also skip when incoming
	// branch is null/falsy but the card already has a persisted branch — the
	// agent may be temporarily detached and we don't want to erase the branch.
	if (branch === undefined) {
		return { board, updated: false };
	}
	const normalizedBranch = branch || null;
	// Don't erase a persisted branch when the incoming value is null — the
	// agent may be temporarily detached.
	if (normalizedBranch === null) {
		const hasExistingBranch = board.columns.some((col) =>
			col.cards.some((card) => card.id === taskId && typeof card.branch === "string"),
		);
		if (hasExistingBranch) {
			return { board, updated: false };
		}
	}
	const { columns, updated } = updateCardInBoard(board, taskId, (card) => {
		if ((card.branch ?? null) === normalizedBranch) {
			return null;
		}
		return {
			...card,
			branch: normalizedBranch,
			updatedAt: Date.now(),
		};
	});
	if (!updated) {
		return { board, updated: false };
	}
	return { board: withUpdatedColumns(board, columns), updated: true };
}

export function removeTask(board: BoardData, taskId: string): { board: BoardData; removed: boolean } {
	const removed = runtimeTaskState.deleteTasksFromBoard(board, [taskId]);
	return { board: removed.board, removed: removed.deleted };
}

export function clearColumnTasks(
	board: BoardData,
	columnId: BoardColumnId,
): { board: BoardData; clearedTaskIds: string[] } {
	const targetColumn = board.columns.find((column) => column.id === columnId);
	if (!targetColumn || targetColumn.cards.length === 0) {
		return { board, clearedTaskIds: [] };
	}

	const clearedTaskIds = targetColumn.cards.map((card) => card.id);
	const cleared = runtimeTaskState.deleteTasksFromBoard(board, clearedTaskIds);

	return {
		board: cleared.board,
		clearedTaskIds,
	};
}

export function findCardSelection(board: BoardData, taskId: string): CardSelection | null {
	for (const column of board.columns) {
		const card = column.cards.find((task) => task.id === taskId);
		if (card) {
			return {
				card,
				column,
				allColumns: board.columns,
			};
		}
	}
	return null;
}

export function toggleTaskPinned(board: BoardData, taskId: string): { board: BoardData; toggled: boolean } {
	const selection = findCardSelection(board, taskId);
	if (!selection) {
		return { board, toggled: false };
	}
	const updated = runtimeTaskState.updateTask(
		board,
		taskId,
		createRuntimeTaskUpdateInput(selection.card, {
			pinned: !selection.card.pinned,
		}),
	);
	return { board: updated.board, toggled: updated.updated };
}

export function getTaskColumnId(board: BoardData, taskId: string): BoardColumnId | null {
	return runtimeTaskState.getTaskColumnId(board, taskId);
}
