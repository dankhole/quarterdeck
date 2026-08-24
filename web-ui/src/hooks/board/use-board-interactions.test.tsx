import { act, type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBoardInteractions } from "@/hooks/board/use-board-interactions";
import { shouldWarnForNonIsolatedResume } from "@/hooks/board/use-task-lifecycle";
import type { UseTaskLifecycleOperationsResult } from "@/hooks/board/use-task-lifecycle-operations";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import type { BoardCard, BoardData } from "@/types";

const showAppToastMock = vi.hoisted(() => vi.fn());
const useLinkedBacklogTaskActionsMock = vi.hoisted(() => vi.fn());
const useProgrammaticCardMovesMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	notifyError: vi.fn(),
	showAppToast: showAppToastMock,
}));

vi.mock("@/hooks/board/use-linked-backlog-task-actions", () => ({
	useLinkedBacklogTaskActions: useLinkedBacklogTaskActionsMock,
}));

vi.mock("@/hooks/board/use-programmatic-card-moves", () => ({
	useProgrammaticCardMoves: useProgrammaticCardMovesMock,
}));

function createTask(taskId: string, prompt: string, createdAt: number): BoardCard {
	return {
		id: taskId,
		title: null,
		prompt,
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function createBoard(task: BoardCard = createTask("task-1", "Backlog task", 1), columnId = "backlog"): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: columnId === "backlog" ? [task] : [] },
			{ id: "in_progress", title: "In Progress", cards: columnId === "in_progress" ? [task] : [] },
			{ id: "review", title: "Review", cards: columnId === "review" ? [task] : [] },
			{ id: "trash", title: "Trash", cards: columnId === "trash" ? [task] : [] },
		],
		dependencies: [],
	};
}

interface HookSnapshot {
	handleRestoreTaskFromTrash: (taskId: string) => void;
	handleRestartTaskSession: (taskId: string) => void;
	handleStartTask: (taskId: string) => void;
	handleCardSelect: (taskId: string) => void;
}

function createRect(width: number, height: number): DOMRect {
	return {
		x: 0,
		y: 0,
		left: 0,
		top: 0,
		width,
		height,
		right: width,
		bottom: height,
		toJSON: () => ({}),
	} as DOMRect;
}

function HookHarness({
	board,
	setBoard,
	executeTaskLifecycle,
	sessions = {},
	selectedCard = null,
	setSelectedTaskIdOverride,
	onSnapshot,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	executeTaskLifecycle: UseTaskLifecycleOperationsResult["executeTaskLifecycle"];
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	selectedCard?: { card: BoardCard; column: { id: "backlog" | "in_progress" | "review" | "trash" } } | null;
	setSelectedTaskIdOverride?: Dispatch<SetStateAction<string | null>>;
	onSnapshot?: (snapshot: HookSnapshot) => void;
}): null {
	const [, setSelectedTaskId] = useState<string | null>(null);
	const [, setIsClearTrashDialogOpen] = useState(false);
	const actions = useBoardInteractions({
		board,
		setBoard,
		sessions,
		selectedCard,
		selectedTaskId: null,
		currentProjectId: "project-1",
		setSelectedTaskId: setSelectedTaskIdOverride ?? setSelectedTaskId,
		setIsClearTrashDialogOpen,
		closeGitHistory: () => {},
		executeTaskLifecycle,
		showTrashWorktreeNotice: true,
		saveTrashWorktreeNoticeDismissed: () => {},
	});

	useEffect(() => {
		onSnapshot?.({
			handleRestoreTaskFromTrash: actions.handleRestoreTaskFromTrash,
			handleRestartTaskSession: actions.handleRestartTaskSession,
			handleStartTask: actions.handleStartTask,
			handleCardSelect: actions.handleCardSelect,
		});
	}, [
		actions.handleCardSelect,
		actions.handleRestartTaskSession,
		actions.handleRestoreTaskFromTrash,
		actions.handleStartTask,
		onSnapshot,
	]);

	return null;
}

describe("useBoardInteractions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			return window.setTimeout(() => callback(performance.now()), 16);
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle: number) => {
			window.clearTimeout(handle);
		});
		showAppToastMock.mockReset();
		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
		});
		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		vi.restoreAllMocks();
		vi.useRealTimers();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	describe("shouldWarnForNonIsolatedResume", () => {
		it("warns only when targeted resume identity is unavailable", () => {
			expect(shouldWarnForNonIsolatedResume(null, "session-1")).toBe(true);
			expect(shouldWarnForNonIsolatedResume("claude", null)).toBe(true);
			expect(shouldWarnForNonIsolatedResume("claude", "session-1")).toBe(false);
			expect(shouldWarnForNonIsolatedResume("codex", "session-1")).toBe(false);
		});
	});

	it("waits for a new backlog card to settle before sending one start command", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const tryProgrammaticCardMove = vi.fn(() => "unavailable" as const);
		useProgrammaticCardMovesMock.mockReturnValue({
			...useProgrammaticCardMovesMock(),
			tryProgrammaticCardMove,
		});
		let measurementCount = 0;
		const boardElement = document.createElement("section");
		boardElement.className = "kb-board";
		const taskElement = document.createElement("div");
		taskElement.dataset.taskId = "task-1";
		vi.spyOn(taskElement, "getBoundingClientRect").mockImplementation(() => {
			measurementCount += 1;
			return createRect(160, measurementCount === 1 ? 44 : 96);
		});
		boardElement.appendChild(taskElement);
		document.body.appendChild(boardElement);
		const board = createBoard();
		const executeTaskLifecycle = vi.fn<UseTaskLifecycleOperationsResult["executeTaskLifecycle"]>(async () => null);

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={vi.fn()}
					executeTaskLifecycle={executeTaskLifecycle}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => requireSnapshot(latestSnapshot).handleStartTask("task-1"));
		expect(tryProgrammaticCardMove).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(48);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(tryProgrammaticCardMove).toHaveBeenCalledWith("task-1", "backlog", "in_progress");
		expect(executeTaskLifecycle).toHaveBeenCalledWith({ kind: "start", taskId: "task-1", taskCreatedAt: 1 });
		boardElement.remove();
	});

	it("starts immediately from detail view without a second client-side lifecycle chain", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const board = createBoard();
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>();
		const executeTaskLifecycle = vi.fn<UseTaskLifecycleOperationsResult["executeTaskLifecycle"]>(async () => null);

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					executeTaskLifecycle={executeTaskLifecycle}
					selectedCard={{ card: board.columns[0]!.cards[0]!, column: { id: "backlog" } }}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => requireSnapshot(latestSnapshot).handleStartTask("task-1"));

		expect(setBoard).toHaveBeenCalledOnce();
		expect(executeTaskLifecycle).toHaveBeenCalledOnce();
		expect(executeTaskLifecycle).toHaveBeenCalledWith({ kind: "start", taskId: "task-1", taskCreatedAt: 1 });
	});

	it("restores through one high-level command and leaves compensation to the server result", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const trashTask = createTask("task-trash", "Trash task", 2);
		let boardState = createBoard(trashTask, "trash");
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((next) => {
			boardState = typeof next === "function" ? next(boardState) : next;
		});
		const executeTaskLifecycle = vi.fn<UseTaskLifecycleOperationsResult["executeTaskLifecycle"]>(async () => null);

		await act(async () => {
			root.render(
				<HookHarness
					board={boardState}
					setBoard={setBoard}
					executeTaskLifecycle={executeTaskLifecycle}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleRestoreTaskFromTrash("task-trash");
			await Promise.resolve();
		});

		expect(executeTaskLifecycle).toHaveBeenCalledWith({
			kind: "restore",
			taskId: "task-trash",
			taskCreatedAt: 2,
		});
		expect(setBoard).toHaveBeenCalledOnce();
		expect(boardState.columns.find((column) => column.id === "review")?.cards[0]?.id).toBe("task-trash");
	});

	it.each(["in_progress", "review"] as const)(
		"restarts a %s task through one command tied to the current session instance",
		async (columnId) => {
			let latestSnapshot: HookSnapshot | null = null;
			const task = createTask("task-restart", "Restart task", 3);
			const board = createBoard(task, columnId);
			const sessions = {
				"task-restart": createTestTaskSessionSummary({
					taskId: "task-restart",
					sessionInstanceId: "session-current",
					state: columnId === "review" ? "awaiting_review" : "running",
				}),
			};
			const executeTaskLifecycle = vi.fn<UseTaskLifecycleOperationsResult["executeTaskLifecycle"]>(async () => null);

			await act(async () => {
				root.render(
					<HookHarness
						board={board}
						setBoard={vi.fn()}
						executeTaskLifecycle={executeTaskLifecycle}
						sessions={sessions}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});
			await act(async () => {
				requireSnapshot(latestSnapshot).handleRestartTaskSession("task-restart");
				await Promise.resolve();
			});

			expect(executeTaskLifecycle).toHaveBeenCalledWith({
				kind: "restart",
				taskId: "task-restart",
				taskCreatedAt: 3,
				sessionInstanceId: "session-current",
			});
		},
	);

	it("ignores card selection requests for trashed tasks", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();
		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(createTask("task-trash", "Trash task", 2), "trash")}
					setBoard={vi.fn()}
					executeTaskLifecycle={async () => null}
					setSelectedTaskIdOverride={setSelectedTaskId}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => requireSnapshot(latestSnapshot).handleCardSelect("task-trash"));
		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});
});

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}
