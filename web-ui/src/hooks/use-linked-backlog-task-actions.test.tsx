import { act, type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskTrashWarningViewModel } from "@/components/task-trash-warning-dialog";
import { useLinkedBacklogTaskActions } from "@/hooks/use-linked-backlog-task-actions";
import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import type { BoardCard, BoardColumnId, BoardData, BoardDependency } from "@/types";

const toastMock = vi.hoisted(() => vi.fn());
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock needs flexible return type
const getTaskWorkspaceSnapshotMock = vi.hoisted(() => vi.fn((): any => null));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock needs flexible return type
const getTaskWorkspaceInfoMock = vi.hoisted(() => vi.fn((): any => null));

vi.mock("sonner", () => ({
	toast: toastMock,
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	getTaskWorkspaceSnapshot: getTaskWorkspaceSnapshotMock,
	getTaskWorkspaceInfo: getTaskWorkspaceInfoMock,
}));

function createTask(taskId: string, prompt: string, createdAt: number): BoardCard {
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

function createBoard(dependencies: BoardDependency[] = []): BoardData {
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

interface RequestMoveTaskToTrashOptions {
	optimisticMoveApplied?: boolean;
	skipWorkingChangeWarning?: boolean;
}

interface HookSnapshot {
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

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (snapshot === null) throw new Error("Expected a hook snapshot.");
	return snapshot;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

function HookHarness({
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
}: {
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
}): null {
	const [board, setBoard] = useState<BoardData>(() => (boardFactory ? boardFactory() : createBoard()));
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const actions = useLinkedBacklogTaskActions({
		board,
		setBoard,
		setSelectedTaskId: setSelectedTaskIdOverride ?? setSelectedTaskId,
		stopTaskSession: stopTaskSession ?? (async () => {}),
		cleanupTaskWorkspace: cleanupTaskWorkspace ?? (async () => null),
		maybeRequestNotificationPermissionForTaskStart: () => {},
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

describe("useLinkedBacklogTaskActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		toastMock.mockReset();
		getTaskWorkspaceSnapshotMock.mockReset();
		getTaskWorkspaceInfoMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("creates a dependency link between tasks", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;

		await act(async () => {
			initialSnapshot.handleCreateDependency("task-1", "task-2");
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an updated hook snapshot.");
		}
		const snapshot = latestSnapshot as HookSnapshot;

		expect(snapshot.board.dependencies).toHaveLength(1);
		expect(snapshot.board.dependencies[0]).toMatchObject({
			fromTaskId: "task-1",
			toTaskId: "task-2",
		});
	});

	it("auto-starts linked backlog tasks when a parent task is trashed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const kickoffTaskInProgress = vi.fn(async () => true);
		const boardFactory = () =>
			createBoard([
				{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
				{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
			]);

		await act(async () => {
			root.render(
				<HookHarness
					boardFactory={boardFactory}
					kickoffTaskInProgress={kickoffTaskInProgress}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
		});

		expect(kickoffTaskInProgress).toHaveBeenCalledTimes(2);
	});

	it("uses animated backlog starts for dependency-unblocked tasks when available", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const kickoffTaskInProgress = vi.fn(async () => true);
		const startBacklogTaskWithAnimation = vi.fn(async (task: BoardCard) => task.id === "task-1");
		const waitForBacklogStartAnimationAvailability = vi.fn(async () => {});
		const boardFactory = () =>
			createBoard([
				{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
				{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
			]);

		await act(async () => {
			root.render(
				<HookHarness
					boardFactory={boardFactory}
					kickoffTaskInProgress={kickoffTaskInProgress}
					startBacklogTaskWithAnimation={startBacklogTaskWithAnimation}
					waitForBacklogStartAnimationAvailability={waitForBacklogStartAnimationAvailability}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
		});

		expect(startBacklogTaskWithAnimation).toHaveBeenCalledTimes(2);
		expect(startBacklogTaskWithAnimation.mock.calls[0]?.[0]).toMatchObject({ id: "task-1" });
		expect(startBacklogTaskWithAnimation.mock.calls[1]?.[0]).toMatchObject({ id: "task-3" });
		expect(waitForBacklogStartAnimationAvailability).toHaveBeenCalledTimes(1);
		expect(kickoffTaskInProgress).not.toHaveBeenCalled();
	});

	it("stops the main task session and its detail terminal shell when a task is trashed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const stopTaskSession = vi.fn(async (_taskId: string) => {});

		await act(async () => {
			root.render(
				<HookHarness
					stopTaskSession={stopTaskSession}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
		});

		expect(stopTaskSession).toHaveBeenCalledTimes(2);
		expect(stopTaskSession).toHaveBeenNthCalledWith(1, reviewTask.id, { waitForExit: true });
		expect(stopTaskSession).toHaveBeenNthCalledWith(2, getDetailTerminalTaskId(reviewTask.id));
	});

	it("trashes tasks directly through the request handler", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async (_taskId: string) => null);

		await act(async () => {
			root.render(
				<HookHarness
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an updated hook snapshot.");
		}
		const nextSnapshot = latestSnapshot as HookSnapshot;
		expect(nextSnapshot.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(0);
		expect(nextSnapshot.board.columns.find((column) => column.id === "trash")?.cards[0]?.id).toBe("task-2");
		expect(cleanupTaskWorkspace).toHaveBeenCalledWith("task-2");
	});

	it("can queue the next dependency-unblocked animation before the previous start resolves", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const firstKickoff = createDeferred<boolean>();
		const secondKickoff = createDeferred<boolean>();
		const waitForSecondAnimation = createDeferred<void>();
		const startBacklogTaskWithAnimation = vi.fn((task: BoardCard) => {
			if (task.id === "task-1") {
				return firstKickoff.promise;
			}
			return secondKickoff.promise;
		});
		const waitForBacklogStartAnimationAvailability = vi.fn(async () => {
			await waitForSecondAnimation.promise;
		});
		const boardFactory = () =>
			createBoard([
				{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
				{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
			]);

		await act(async () => {
			root.render(
				<HookHarness
					boardFactory={boardFactory}
					startBacklogTaskWithAnimation={startBacklogTaskWithAnimation}
					waitForBacklogStartAnimationAvailability={waitForBacklogStartAnimationAvailability}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		let movePromise: Promise<void> | null = null;
		await act(async () => {
			movePromise = initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
			await Promise.resolve();
		});

		expect(startBacklogTaskWithAnimation).toHaveBeenCalledTimes(1);
		expect(startBacklogTaskWithAnimation.mock.calls[0]?.[0]).toMatchObject({ id: "task-1" });

		await act(async () => {
			waitForSecondAnimation.resolve();
			await Promise.resolve();
		});

		expect(startBacklogTaskWithAnimation).toHaveBeenCalledTimes(2);
		expect(startBacklogTaskWithAnimation.mock.calls[1]?.[0]).toMatchObject({ id: "task-3" });

		await act(async () => {
			firstKickoff.resolve(true);
			secondKickoff.resolve(true);
			await movePromise;
		});
	});

	describe("trash confirmation dialog", () => {
		it("calls onRequestTrashConfirmation when task has uncommitted changes", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const onRequestTrashConfirmation = vi.fn();
			getTaskWorkspaceSnapshotMock.mockReturnValue({
				taskId: "task-2",
				path: "/tmp/task-2",
				branch: "task-2-branch",
				isDetached: false,
				headCommit: "abc123",
				changedFiles: 3,
			});
			getTaskWorkspaceInfoMock.mockReturnValue({
				taskId: "task-2",
				path: "/tmp/task-2",
				exists: true,
				baseRef: "main",
				branch: "task-2-branch",
				isDetached: false,
				headCommit: "abc123",
			});

			await act(async () => {
				root.render(
					<HookHarness
						onRequestTrashConfirmation={onRequestTrashConfirmation}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
			});

			expect(onRequestTrashConfirmation).toHaveBeenCalledTimes(1);
			expect(onRequestTrashConfirmation).toHaveBeenCalledWith(
				expect.objectContaining({ fileCount: 3 }),
				expect.objectContaining({ id: "task-2" }),
				"review",
				false,
			);

			// Task should NOT have been trashed — dialog intercepts
			const nextSnapshot = requireSnapshot(latestSnapshot);
			expect(nextSnapshot.board.columns.find((c) => c.id === "review")?.cards).toHaveLength(1);
		});

		it("passes optimisticMoveApplied through to the confirmation callback", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const onRequestTrashConfirmation = vi.fn();
			getTaskWorkspaceSnapshotMock.mockReturnValue({
				taskId: "task-2",
				path: "/tmp/task-2",
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: 1,
			});

			await act(async () => {
				root.render(
					<HookHarness
						onRequestTrashConfirmation={onRequestTrashConfirmation}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review", { optimisticMoveApplied: true });
			});

			expect(onRequestTrashConfirmation).toHaveBeenCalledWith(expect.anything(), expect.anything(), "review", true);
		});

		it("skips confirmation dialog when skipWorkingChangeWarning is true", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const onRequestTrashConfirmation = vi.fn();
			const cleanupTaskWorkspace = vi.fn(async () => null);
			getTaskWorkspaceSnapshotMock.mockReturnValue({
				taskId: "task-2",
				path: "/tmp/task-2",
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: 5,
			});

			await act(async () => {
				root.render(
					<HookHarness
						onRequestTrashConfirmation={onRequestTrashConfirmation}
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review", {
					skipWorkingChangeWarning: true,
				});
			});

			expect(onRequestTrashConfirmation).not.toHaveBeenCalled();
			// Task should be trashed
			const nextSnapshot = requireSnapshot(latestSnapshot);
			expect(nextSnapshot.board.columns.find((c) => c.id === "review")?.cards).toHaveLength(0);
			expect(nextSnapshot.board.columns.find((c) => c.id === "trash")?.cards[0]?.id).toBe("task-2");
		});

		it("skips confirmation when changedFiles is 0", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const onRequestTrashConfirmation = vi.fn();
			const cleanupTaskWorkspace = vi.fn(async () => null);
			getTaskWorkspaceSnapshotMock.mockReturnValue({
				taskId: "task-2",
				path: "/tmp/task-2",
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: 0,
			});

			await act(async () => {
				root.render(
					<HookHarness
						onRequestTrashConfirmation={onRequestTrashConfirmation}
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
			});

			expect(onRequestTrashConfirmation).not.toHaveBeenCalled();
			const nextSnapshot = requireSnapshot(latestSnapshot);
			expect(nextSnapshot.board.columns.find((c) => c.id === "trash")?.cards[0]?.id).toBe("task-2");
		});

		it("skips confirmation when snapshot is null", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const onRequestTrashConfirmation = vi.fn();
			const cleanupTaskWorkspace = vi.fn(async () => null);
			getTaskWorkspaceSnapshotMock.mockReturnValue(null);

			await act(async () => {
				root.render(
					<HookHarness
						onRequestTrashConfirmation={onRequestTrashConfirmation}
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
			});

			expect(onRequestTrashConfirmation).not.toHaveBeenCalled();
			const nextSnapshot = requireSnapshot(latestSnapshot);
			expect(nextSnapshot.board.columns.find((c) => c.id === "trash")?.cards[0]?.id).toBe("task-2");
		});

		it("skips confirmation when changedFiles is null", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const onRequestTrashConfirmation = vi.fn();
			const cleanupTaskWorkspace = vi.fn(async () => null);
			getTaskWorkspaceSnapshotMock.mockReturnValue({
				taskId: "task-2",
				path: "/tmp/task-2",
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
			});

			await act(async () => {
				root.render(
					<HookHarness
						onRequestTrashConfirmation={onRequestTrashConfirmation}
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
			});

			expect(onRequestTrashConfirmation).not.toHaveBeenCalled();
			const nextSnapshot = requireSnapshot(latestSnapshot);
			expect(nextSnapshot.board.columns.find((c) => c.id === "trash")?.cards[0]?.id).toBe("task-2");
		});

		it("updates selection when trashing a task that is already in trash from optimistic move", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();
			const stopTaskSession = vi.fn(async () => {});
			const cleanupTaskWorkspace = vi.fn(async () => null);

			// Board with task already in trash (simulating optimistic drag move already applied)
			const boardFactory = (): BoardData => ({
				columns: [
					{ id: "backlog", title: "Backlog", cards: [] },
					{
						id: "in_progress",
						title: "In Progress",
						cards: [createTask("task-ip", "In progress task", 4)],
					},
					{ id: "review", title: "Review", cards: [] },
					{ id: "trash", title: "Trash", cards: [createTask("task-2", "Review task", 2)] },
				],
				dependencies: [],
			});

			await act(async () => {
				root.render(
					<HookHarness
						boardFactory={boardFactory}
						stopTaskSession={stopTaskSession}
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						setSelectedTaskIdOverride={setSelectedTaskId}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);
			const trashTask = initialSnapshot.board.columns.find((c) => c.id === "trash")?.cards[0];
			if (!trashTask) throw new Error("Expected a trash task.");

			await act(async () => {
				await initialSnapshot.confirmMoveTaskToTrash(trashTask, initialSnapshot.board);
			});

			// setSelectedTaskId should have been called (updater function)
			expect(setSelectedTaskId).toHaveBeenCalled();
			expect(stopTaskSession).toHaveBeenCalledTimes(2);
			expect(cleanupTaskWorkspace).toHaveBeenCalledWith("task-2");
		});
	});

	describe("worktree notice toast", () => {
		it("shows toast when trashing from in_progress with showTrashWorktreeNotice enabled", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const cleanupTaskWorkspace = vi.fn(async () => null);

			// Board with a task in in_progress
			const boardFactory = (): BoardData => ({
				columns: [
					{ id: "backlog", title: "Backlog", cards: [] },
					{
						id: "in_progress",
						title: "In Progress",
						cards: [createTask("task-ip", "In progress task", 1)],
					},
					{ id: "review", title: "Review", cards: [] },
					{ id: "trash", title: "Trash", cards: [] },
				],
				dependencies: [],
			});

			await act(async () => {
				root.render(
					<HookHarness
						boardFactory={boardFactory}
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						showTrashWorktreeNotice={true}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-ip", "in_progress");
			});

			expect(toastMock).toHaveBeenCalledWith(
				"Task workspace removed",
				expect.objectContaining({
					description: expect.stringContaining("worktree was deleted"),
				}),
			);
		});

		it("shows toast when trashing from review column", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const cleanupTaskWorkspace = vi.fn(async () => null);

			await act(async () => {
				root.render(
					<HookHarness
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						showTrashWorktreeNotice={true}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
			});

			expect(toastMock).toHaveBeenCalledWith("Task workspace removed", expect.anything());
		});

		it("does not show toast when trashing from backlog", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const cleanupTaskWorkspace = vi.fn(async () => null);

			await act(async () => {
				root.render(
					<HookHarness
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						showTrashWorktreeNotice={true}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-1", "backlog");
			});

			expect(toastMock).not.toHaveBeenCalled();
		});

		it("does not show toast when showTrashWorktreeNotice is false", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const cleanupTaskWorkspace = vi.fn(async () => null);

			await act(async () => {
				root.render(
					<HookHarness
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						showTrashWorktreeNotice={false}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
			});

			expect(toastMock).not.toHaveBeenCalled();
		});

		it("does not show toast when skipWorkingChangeWarning bypasses the normal path", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const cleanupTaskWorkspace = vi.fn(async () => null);

			await act(async () => {
				root.render(
					<HookHarness
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						showTrashWorktreeNotice={true}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review", {
					skipWorkingChangeWarning: true,
				});
			});

			expect(toastMock).not.toHaveBeenCalled();
		});

		it("toast action calls saveTrashWorktreeNoticeDismissed", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const cleanupTaskWorkspace = vi.fn(async () => null);
			const saveTrashWorktreeNoticeDismissed = vi.fn();

			await act(async () => {
				root.render(
					<HookHarness
						cleanupTaskWorkspace={cleanupTaskWorkspace}
						showTrashWorktreeNotice={true}
						saveTrashWorktreeNoticeDismissed={saveTrashWorktreeNoticeDismissed}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
			});

			expect(toastMock).toHaveBeenCalledTimes(1);

			// Simulate clicking "Don't show again"
			const toastOptions = toastMock.mock.calls[0]![1];
			toastOptions.cancel.onClick();

			expect(saveTrashWorktreeNoticeDismissed).toHaveBeenCalledTimes(1);
		});

		it("does not show toast when confirmation dialog was triggered", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const onRequestTrashConfirmation = vi.fn();
			getTaskWorkspaceSnapshotMock.mockReturnValue({
				taskId: "task-2",
				path: "/tmp/task-2",
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: 3,
			});

			await act(async () => {
				root.render(
					<HookHarness
						onRequestTrashConfirmation={onRequestTrashConfirmation}
						showTrashWorktreeNotice={true}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			const initialSnapshot = requireSnapshot(latestSnapshot);

			await act(async () => {
				await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
			});

			expect(onRequestTrashConfirmation).toHaveBeenCalledTimes(1);
			expect(toastMock).not.toHaveBeenCalled();
		});
	});
});
