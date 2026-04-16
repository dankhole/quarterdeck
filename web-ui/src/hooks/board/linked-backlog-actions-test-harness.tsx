import { act, type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach } from "vitest";

import type { TaskTrashWarningViewModel } from "@/components/task-trash-warning-dialog";
import { useLinkedBacklogTaskActions } from "@/hooks/board/use-linked-backlog-task-actions";
import type { BoardCard, BoardColumnId, BoardData, BoardDependency } from "@/types";

export interface RequestMoveTaskToTrashOptions {
	optimisticMoveApplied?: boolean;
	skipWorkingChangeWarning?: boolean;
}

export interface HookSnapshot {
	board: BoardData;
	selectedTaskId: string | null;
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: RequestMoveTaskToTrashOptions,
	) => Promise<void>;
}

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
}

export function createTask(taskId: string, prompt: string, createdAt: number): BoardCard {
	return {
		id: taskId,
		title: null,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

export function createBoard(dependencies: BoardDependency[] = []): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [createTask("task-1", "Backlog task", 1), createTask("task-3", "Second backlog task", 3)],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [createTask("task-2", "Review task", 2)],
			},
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies,
	};
}

export function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (snapshot === null) throw new Error("Expected a hook snapshot.");
	return snapshot;
}

export function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

export interface HookHarnessProps {
	boardFactory?: () => BoardData;
	onSnapshot: (snapshot: HookSnapshot) => void;
	kickoffTaskInProgress?: (
		task: BoardCard,
		taskId: string,
		fromColumnId: "backlog" | "in_progress" | "review" | "trash",
		options?: { optimisticMove?: boolean },
	) => Promise<boolean>;
	startBacklogTaskWithAnimation?: (task: BoardCard) => Promise<boolean>;
	waitForBacklogStartAnimationAvailability?: () => Promise<void>;
	stopTaskSession?: (taskId: string) => Promise<void>;
	cleanupTaskWorkspace?: (taskId: string) => Promise<unknown>;
	onRequestTrashConfirmation?: (
		viewModel: TaskTrashWarningViewModel,
		card: BoardCard,
		fromColumnId: BoardColumnId,
		optimisticMoveApplied: boolean,
	) => void;
	showTrashWorktreeNotice?: boolean;
	saveTrashWorktreeNoticeDismissed?: () => void;
	setSelectedTaskIdOverride?: Dispatch<SetStateAction<string | null>>;
}

export function HookHarness({
	boardFactory,
	onSnapshot,
	kickoffTaskInProgress,
	startBacklogTaskWithAnimation,
	waitForBacklogStartAnimationAvailability,
	stopTaskSession,
	cleanupTaskWorkspace,
	onRequestTrashConfirmation,
	showTrashWorktreeNotice,
	saveTrashWorktreeNoticeDismissed,
	setSelectedTaskIdOverride,
}: HookHarnessProps): null {
	const [board, setBoard] = useState<BoardData>(() => (boardFactory ? boardFactory() : createBoard()));
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const actions = useLinkedBacklogTaskActions({
		board,
		setBoard,
		setSelectedTaskId: setSelectedTaskIdOverride ?? setSelectedTaskId,
		stopTaskSession: stopTaskSession ?? (async () => {}),
		cleanupTaskWorkspace: cleanupTaskWorkspace ?? (async () => null),
		kickoffTaskInProgress: kickoffTaskInProgress ?? (async (_task: BoardCard, _taskId: string) => true),
		startBacklogTaskWithAnimation,
		waitForBacklogStartAnimationAvailability,
		onRequestTrashConfirmation,
		showTrashWorktreeNotice,
		saveTrashWorktreeNoticeDismissed,
	});

	useEffect(() => {
		onSnapshot({
			board,
			selectedTaskId,
			handleCreateDependency: actions.handleCreateDependency,
			confirmMoveTaskToTrash: actions.confirmMoveTaskToTrash,
			requestMoveTaskToTrash: actions.requestMoveTaskToTrash,
		});
	}, [
		actions.confirmMoveTaskToTrash,
		actions.handleCreateDependency,
		actions.requestMoveTaskToTrash,
		board,
		selectedTaskId,
		onSnapshot,
	]);

	return null;
}

export interface TestContext {
	container: HTMLDivElement;
	root: Root;
}

export function useTestEnvironment(): TestContext {
	const ctx = {} as TestContext;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		ctx.container = document.createElement("div");
		document.body.appendChild(ctx.container);
		ctx.root = createRoot(ctx.container);
	});

	afterEach(() => {
		act(() => {
			ctx.root.unmount();
		});
		ctx.container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	return ctx;
}
