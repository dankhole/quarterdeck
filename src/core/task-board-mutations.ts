import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
} from "./api-contract";
import { createUniqueTaskId } from "./task-id";

export interface RuntimeCreateTaskInput {
	taskId?: string;
	title?: string | null;
	prompt: string;
	images?: RuntimeTaskImage[];
	baseRef: string;
	agentId?: RuntimeAgentId;
	codexOptions?: RuntimeBoardCard["codexOptions"];
	useWorktree?: boolean;
	branch?: string;
	pinned?: boolean;
}

export interface RuntimeUpdateTaskInput {
	title?: string | null;
	prompt: string;
	images?: RuntimeTaskImage[];
	baseRef: string;
	useWorktree?: boolean;
	pinned?: boolean;
}

export interface RuntimePatchTaskInput {
	title?: string | null;
	agentId?: RuntimeAgentId | null;
	baseRef?: string;
	baseRefPinned?: boolean | null;
	useWorktree?: boolean | null;
	workingDirectory?: string | null;
	branch?: string | null;
	pinned?: boolean | null;
}

// Copy image metadata so board tasks do not retain caller-owned array or object references.
function cloneTaskImages(images?: RuntimeTaskImage[]): RuntimeTaskImage[] | undefined {
	return images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined;
}

export interface RuntimeCreateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard;
}

export interface RuntimeMoveTaskResult {
	moved: boolean;
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	fromColumnId: RuntimeBoardColumnId | null;
}

export interface RuntimeUpdateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	updated: boolean;
}

export interface RuntimeReorderTaskResult {
	board: RuntimeBoardData;
	reordered: boolean;
}

export interface RuntimeReorderColumnResult {
	board: RuntimeBoardData;
	reordered: boolean;
}

export interface RuntimeDeleteTasksResult {
	board: RuntimeBoardData;
	deleted: boolean;
	deletedTaskIds: string[];
}

function collectExistingTaskIds(board: RuntimeBoardData): Set<string> {
	const existingIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			existingIds.add(card.id);
		}
	}
	return existingIds;
}

function findTaskLocation(
	board: RuntimeBoardData,
	taskId: string,
): {
	columnIndex: number;
	taskIndex: number;
	columnId: RuntimeBoardColumnId;
	task: RuntimeBoardCard;
} | null {
	for (const [columnIndex, column] of board.columns.entries()) {
		const taskIndex = column.cards.findIndex((card) => card.id === taskId);
		if (taskIndex === -1) {
			continue;
		}
		const task = column.cards[taskIndex];
		if (!task) {
			continue;
		}
		return {
			columnIndex,
			taskIndex,
			columnId: column.id,
			task,
		};
	}
	return null;
}

/** Find a card by ID across all board columns. Returns the card or null. */
export function findCardInBoard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	return findTaskLocation(board, taskId)?.task ?? null;
}

export function addTaskToColumn(
	board: RuntimeBoardData,
	columnId: RuntimeBoardColumnId,
	input: RuntimeCreateTaskInput,
	randomUuid: () => string,
	now: number = Date.now(),
): RuntimeCreateTaskResult {
	const prompt = input.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt is required.");
	}
	const baseRef = input.baseRef.trim();
	if (!baseRef && input.useWorktree !== false) {
		throw new Error("Task baseRef is required.");
	}
	const existingIds = collectExistingTaskIds(board);
	const explicitTaskId = input.taskId?.trim();
	if (explicitTaskId && existingIds.has(explicitTaskId)) {
		throw new Error(`Task "${explicitTaskId}" already exists.`);
	}
	const task: RuntimeBoardCard = {
		id: explicitTaskId || createUniqueTaskId(existingIds, randomUuid),
		...(columnId === "review" ? { unstarted: true } : {}),
		title: input.title?.trim() || null,
		prompt,
		images: cloneTaskImages(input.images),
		baseRef,
		...(input.agentId ? { agentId: input.agentId } : {}),
		...(input.codexOptions ? { codexOptions: { ...input.codexOptions } } : {}),
		useWorktree: input.useWorktree,
		branch: input.branch?.trim() || undefined,
		pinned: input.pinned || undefined,
		createdAt: now,
		updatedAt: now,
	};

	const targetColumnIndex = board.columns.findIndex((column) => column.id === columnId);
	if (targetColumnIndex === -1) {
		throw new Error(`Column ${columnId} not found.`);
	}

	const columns = board.columns.map((column, index) => {
		if (index !== targetColumnIndex) {
			return column;
		}
		return {
			...column,
			cards: [task, ...column.cards],
		};
	});

	return {
		board: {
			...board,
			columns,
		},
		task,
	};
}

export function getTaskColumnId(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return null;
	}
	const found = findTaskLocation(board, normalizedTaskId);
	return found ? found.columnId : null;
}

export function deleteTasksFromBoard(board: RuntimeBoardData, taskIds: Iterable<string>): RuntimeDeleteTasksResult {
	const normalizedTaskIds = new Set(
		Array.from(taskIds, (taskId) => taskId.trim()).filter((taskId) => taskId.length > 0),
	);
	if (normalizedTaskIds.size === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIds: string[] = [];
	const columns = board.columns.map((column) => {
		const remainingCards = column.cards.filter((card) => {
			if (!normalizedTaskIds.has(card.id) || (column.id === "trash" && card.pinned)) {
				return true;
			}
			deletedTaskIds.push(card.id);
			return false;
		});
		return remainingCards.length === column.cards.length ? column : { ...column, cards: remainingCards };
	});

	if (deletedTaskIds.length === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	return {
		board: {
			...board,
			columns,
		},
		deleted: true,
		deletedTaskIds,
	};
}

export function moveTaskToColumn(
	board: RuntimeBoardData,
	taskId: string,
	targetColumnId: RuntimeBoardColumnId,
	now: number = Date.now(),
	options: { targetIndex?: number; unstarted?: boolean } = {},
): RuntimeMoveTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}

	const found = findTaskLocation(board, normalizedTaskId);
	if (!found) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}
	if (found.columnId === targetColumnId) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const targetColumnIndex = board.columns.findIndex((column) => column.id === targetColumnId);
	if (targetColumnIndex === -1) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceColumn = board.columns[found.columnIndex];
	const targetColumn = board.columns[targetColumnIndex];
	if (!sourceColumn || !targetColumn) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceCards = [...sourceColumn.cards];
	const [task] = sourceCards.splice(found.taskIndex, 1);
	if (!task) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const movedTask: RuntimeBoardCard = {
		...task,
		...(targetColumnId === "in_progress"
			? { unstarted: undefined }
			: options.unstarted !== undefined
				? { unstarted: options.unstarted || undefined }
				: {}),
		updatedAt: now,
		// Clear workingDirectory as part of the same runtime-owned board command
		// that moves the card. Worktree cleanup runs only after that command flushes.
		...(targetColumnId === "trash" ? { workingDirectory: null } : undefined),
	};
	const targetCards = [...targetColumn.cards];
	const defaultTargetIndex = targetColumnId === "trash" ? 0 : targetCards.length;
	const requestedTargetIndex = options.targetIndex ?? defaultTargetIndex;
	const targetIndex = Math.max(0, Math.min(requestedTargetIndex, targetCards.length));
	targetCards.splice(targetIndex, 0, movedTask);

	const columns = board.columns.map((column, index) => {
		if (index === found.columnIndex) {
			return {
				...column,
				cards: sourceCards,
			};
		}
		if (index === targetColumnIndex) {
			return {
				...column,
				cards: targetCards,
			};
		}
		return column;
	});

	return {
		moved: true,
		board: { ...board, columns },
		task: movedTask,
		fromColumnId: found.columnId,
	};
}

export function reorderTaskInColumn(
	board: RuntimeBoardData,
	taskId: string,
	columnId: RuntimeBoardColumnId,
	targetIndex: number,
): RuntimeReorderTaskResult {
	const found = findTaskLocation(board, taskId.trim());
	if (!found || found.columnId !== columnId) {
		return { board, reordered: false };
	}
	const column = board.columns[found.columnIndex];
	if (!column) {
		return { board, reordered: false };
	}
	const boundedTargetIndex = Math.max(0, Math.min(targetIndex, column.cards.length - 1));
	if (found.taskIndex === boundedTargetIndex) {
		return { board, reordered: false };
	}
	const cards = [...column.cards];
	const [task] = cards.splice(found.taskIndex, 1);
	if (!task) {
		return { board, reordered: false };
	}
	cards.splice(boundedTargetIndex, 0, task);
	const columns = [...board.columns];
	columns[found.columnIndex] = { ...column, cards };
	return {
		board: { ...board, columns },
		reordered: true,
	};
}

export function reorderTasksInColumn(
	board: RuntimeBoardData,
	columnId: RuntimeBoardColumnId,
	taskIds: readonly string[],
): RuntimeReorderColumnResult {
	const columnIndex = board.columns.findIndex((column) => column.id === columnId);
	const column = board.columns[columnIndex];
	if (!column) {
		return { board, reordered: false };
	}
	if (taskIds.length !== column.cards.length) {
		return { board, reordered: false };
	}
	const cardsById = new Map(column.cards.map((card) => [card.id, card]));
	const seenTaskIds = new Set<string>();
	const cards: RuntimeBoardCard[] = [];
	for (const taskId of taskIds) {
		if (seenTaskIds.has(taskId)) {
			return { board, reordered: false };
		}
		seenTaskIds.add(taskId);
		const card = cardsById.get(taskId);
		if (!card) {
			return { board, reordered: false };
		}
		cards.push(card);
	}
	if (cards.every((card, index) => card === column.cards[index])) {
		return { board, reordered: false };
	}
	const columns = [...board.columns];
	columns[columnIndex] = { ...column, cards };
	return { board: { ...board, columns }, reordered: true };
}

export function updateTask(
	board: RuntimeBoardData,
	taskId: string,
	input: RuntimeUpdateTaskInput,
	now: number = Date.now(),
): RuntimeUpdateTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const prompt = input.prompt.trim();
	if (!prompt) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const baseRef = input.baseRef.trim();

	let updatedTask: RuntimeBoardCard | null = null;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== normalizedTaskId) {
				return card;
			}
			columnUpdated = true;
			updatedTask = {
				...card,
				title: input.title === undefined ? card.title : input.title?.trim() || null,
				...(input.title !== undefined ? { titleAutoGenerated: false } : {}),
				prompt,
				images: input.images === undefined ? card.images : cloneTaskImages(input.images),
				baseRef,
				useWorktree: input.useWorktree,
				pinned: input.pinned === undefined ? card.pinned : input.pinned || undefined,
				updatedAt: now,
			};
			return updatedTask;
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updatedTask) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	return {
		board: {
			...board,
			columns,
		},
		task: updatedTask,
		updated: true,
	};
}

export function patchTask(
	board: RuntimeBoardData,
	taskId: string,
	input: RuntimePatchTaskInput,
	now: number = Date.now(),
): RuntimeUpdateTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return { board, task: null, updated: false };
	}

	let updatedTask: RuntimeBoardCard | null = null;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== normalizedTaskId) {
				return card;
			}
			const nextTask: RuntimeBoardCard = {
				...card,
				...(input.title !== undefined ? { title: input.title?.trim() || null, titleAutoGenerated: false } : {}),
				...(input.agentId !== undefined ? { agentId: input.agentId ?? undefined } : {}),
				...(input.baseRef !== undefined ? { baseRef: input.baseRef.trim() } : {}),
				...(input.baseRefPinned !== undefined ? { baseRefPinned: input.baseRefPinned ? true : undefined } : {}),
				...(input.useWorktree !== undefined
					? { useWorktree: input.useWorktree === null ? undefined : input.useWorktree }
					: {}),
				...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
				...(input.branch !== undefined ? { branch: input.branch } : {}),
				...(input.pinned !== undefined ? { pinned: input.pinned ? true : undefined } : {}),
			};
			if (
				nextTask.title === card.title &&
				nextTask.titleAutoGenerated === card.titleAutoGenerated &&
				nextTask.agentId === card.agentId &&
				nextTask.baseRef === card.baseRef &&
				nextTask.baseRefPinned === card.baseRefPinned &&
				nextTask.useWorktree === card.useWorktree &&
				nextTask.workingDirectory === card.workingDirectory &&
				nextTask.branch === card.branch &&
				nextTask.pinned === card.pinned
			) {
				return card;
			}
			columnUpdated = true;
			updatedTask = { ...nextTask, updatedAt: now };
			return updatedTask;
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updatedTask) {
		return { board, task: null, updated: false };
	}
	return {
		board: { ...board, columns },
		task: updatedTask,
		updated: true,
	};
}

function collectBoardTaskIds(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function collectActionableNotificationTaskIds(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		if (column.id !== "in_progress" && column.id !== "review") {
			continue;
		}
		for (const card of column.cards) {
			if (card.unstarted) continue;
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function isLiveSessionSummary(summary: RuntimeTaskSessionSummary): boolean {
	return summary.pid !== null || summary.state === "running";
}

/**
 * Drop session summaries whose cards are no longer on the board. Live
 * summaries (pid !== null or state === "running") are kept so an in-flight
 * agent process — or a still-open shell terminal — stays visible even if the
 * owning card has briefly left the board. Use for the project-state snapshot
 * broadcast and the cross-project notification snapshot.
 */
export function pruneOrphanSessionsForBroadcast(
	sessions: Record<string, RuntimeTaskSessionSummary>,
	board: RuntimeBoardData,
): Record<string, RuntimeTaskSessionSummary> {
	const boardTaskIds = collectBoardTaskIds(board);
	const pruned: Record<string, RuntimeTaskSessionSummary> = {};
	for (const [taskId, summary] of Object.entries(sessions)) {
		if (boardTaskIds.has(taskId) || isLiveSessionSummary(summary)) {
			pruned[taskId] = summary;
		}
	}
	return pruned;
}

/**
 * Actionable board filter for notification projections. Cross-project badges
 * and sounds must only represent tasks the user can act on from active work
 * columns; live orphan process summaries and trashed/unstarted cards remain
 * useful elsewhere, but they should not keep project-level NI/R/F badges alive.
 */
export function pruneOrphanSessionsForNotification(
	sessions: Record<string, RuntimeTaskSessionSummary>,
	board: RuntimeBoardData,
): Record<string, RuntimeTaskSessionSummary> {
	const boardTaskIds = collectActionableNotificationTaskIds(board);
	const pruned: Record<string, RuntimeTaskSessionSummary> = {};
	for (const [taskId, summary] of Object.entries(sessions)) {
		if (boardTaskIds.has(taskId)) {
			pruned[taskId] = summary;
		}
	}
	return pruned;
}

/**
 * Lax filter for live notification deltas. Session-store delivery and durable
 * runtime board projection are separately scheduled, so a live delta can arrive
 * while the corresponding authoritative projection is still committing. Keep
 * board-linked and currently live summaries until the next authoritative
 * notification replacement applies the stricter actionable filter.
 */
export function pruneOrphanSessionsForNotificationDelta(
	sessions: Record<string, RuntimeTaskSessionSummary>,
	board: RuntimeBoardData,
): Record<string, RuntimeTaskSessionSummary> {
	const boardTaskIds = collectBoardTaskIds(board);
	const pruned: Record<string, RuntimeTaskSessionSummary> = {};
	for (const [taskId, summary] of Object.entries(sessions)) {
		if (boardTaskIds.has(taskId) || isLiveSessionSummary(summary)) {
			pruned[taskId] = summary;
		}
	}
	return pruned;
}

/**
 * Strict board-linked filter for persistence. Sessions whose card is no
 * longer on the board are dropped from `sessions.json` so the file does not
 * grow unbounded. Shells and other non-board-linked live entries are also
 * dropped — they are ephemeral and should not survive a restart.
 */
export function pruneOrphanSessionsForPersist(
	sessions: Record<string, RuntimeTaskSessionSummary>,
	board: RuntimeBoardData,
): Record<string, RuntimeTaskSessionSummary> {
	const boardTaskIds = collectBoardTaskIds(board);
	const pruned: Record<string, RuntimeTaskSessionSummary> = {};
	for (const [taskId, summary] of Object.entries(sessions)) {
		if (boardTaskIds.has(taskId)) {
			pruned[taskId] = summary;
		}
	}
	return pruned;
}
