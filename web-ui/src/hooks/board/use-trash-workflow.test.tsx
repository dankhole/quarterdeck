import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardCard, BoardColumnId, BoardData } from "@/types";

import { type UseTrashWorkflowResult, useTrashWorkflow } from "./use-trash-workflow";

type RequestMoveTaskToTrash = (
	taskId: string,
	fromColumnId: BoardColumnId,
	options?: { optimisticMoveApplied?: boolean; skipWorkingChangeWarning?: boolean },
) => Promise<void>;

interface HookSnapshot {
	actions: UseTrashWorkflowResult;
	board: BoardData;
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

const task: BoardCard = {
	id: "task-1",
	title: "Review task",
	prompt: "Review the implementation",
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
};

function createBoard(taskColumnId: "review" | "trash" = "review"): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: taskColumnId === "review" ? [task] : [] },
			{ id: "trash", title: "Trash", cards: taskColumnId === "trash" ? [task] : [] },
		],
		dependencies: [],
	};
}

function HookHarness({
	initialBoard,
	requestMoveTaskToTrash,
	requestMoveTaskToTrashWithAnimation,
	confirmMoveTaskToTrash,
	onSnapshot,
}: {
	initialBoard: BoardData;
	requestMoveTaskToTrash: RequestMoveTaskToTrash;
	requestMoveTaskToTrashWithAnimation: RequestMoveTaskToTrash;
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const [board, setBoard] = useState(initialBoard);
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(task.id);
	const [, setIsClearTrashDialogOpen] = useState(false);

	const actions = useTrashWorkflow({
		board,
		presentLifecycleBoard: setBoard,
		selectedCard: { card: task, column: { id: "review" } },
		selectedTaskId,
		setSelectedTaskId,
		setIsClearTrashDialogOpen,
		executeTaskLifecycle: async () => null,
		resumeTaskFromTrash: async () => {},
		tryProgrammaticCardMove: () => "unavailable",
		requestMoveTaskToTrash,
		requestMoveTaskToTrashWithAnimation,
		confirmMoveTaskToTrash,
	});

	onSnapshot({ actions, board });
	return null;
}

describe("useTrashWorkflow", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
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

	it("keeps a clicked review task in place until confirmation, then starts the existing trash move", async () => {
		let snapshot: HookSnapshot | null = null;
		const requestMoveTaskToTrashWithAnimation = vi.fn<RequestMoveTaskToTrash>(async () => {});
		const confirmMoveTaskToTrash = vi.fn(async () => {});
		const requestMoveTaskToTrash = vi.fn<RequestMoveTaskToTrash>(async (_taskId, fromColumnId) => {
			if (!snapshot) {
				throw new Error("Expected a hook snapshot.");
			}
			snapshot.actions.setTrashWarningState({
				open: true,
				warning: {
					taskTitle: task.title ?? task.prompt,
					fileCount: 0,
					worktreeInfo: null,
					isNonIsolated: false,
				},
				card: task,
				fromColumnId,
				optimisticMoveApplied: false,
			});
		});

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
					requestMoveTaskToTrashWithAnimation={requestMoveTaskToTrashWithAnimation}
					confirmMoveTaskToTrash={confirmMoveTaskToTrash}
					onSnapshot={(nextSnapshot) => {
						snapshot = nextSnapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(snapshot).actions.handleMoveReviewCardToTrash(task.id);
			await Promise.resolve();
		});

		const warningSnapshot = requireSnapshot(snapshot);
		expect(requestMoveTaskToTrash).toHaveBeenCalledWith(task.id, "review");
		expect(requestMoveTaskToTrashWithAnimation).not.toHaveBeenCalled();
		expect(confirmMoveTaskToTrash).not.toHaveBeenCalled();
		expect(warningSnapshot.actions.trashWarningState.open).toBe(true);
		expect(warningSnapshot.board.columns.find((column) => column.id === "review")?.cards).toEqual([task]);
		expect(warningSnapshot.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);

		await act(async () => {
			warningSnapshot.actions.handleCancelTrashWarning();
		});

		const cancelledSnapshot = requireSnapshot(snapshot);
		expect(cancelledSnapshot.actions.trashWarningState.open).toBe(false);
		expect(cancelledSnapshot.board.columns.find((column) => column.id === "review")?.cards).toEqual([task]);
		expect(cancelledSnapshot.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(requestMoveTaskToTrashWithAnimation).not.toHaveBeenCalled();
		expect(confirmMoveTaskToTrash).not.toHaveBeenCalled();

		await act(async () => {
			cancelledSnapshot.actions.handleMoveReviewCardToTrash(task.id);
			await Promise.resolve();
		});

		const confirmedWarningSnapshot = requireSnapshot(snapshot);
		await act(async () => {
			confirmedWarningSnapshot.actions.handleConfirmTrashWarning();
			await Promise.resolve();
		});

		expect(requestMoveTaskToTrash).toHaveBeenCalledTimes(2);
		expect(requestMoveTaskToTrashWithAnimation).toHaveBeenCalledWith(task.id, "review", {
			skipWorkingChangeWarning: true,
		});
		expect(confirmMoveTaskToTrash).not.toHaveBeenCalled();
		expect(requireSnapshot(snapshot).actions.trashWarningState.open).toBe(false);
	});

	it("keeps the existing finalize path for drag moves that are already optimistic", async () => {
		let snapshot: HookSnapshot | null = null;
		const requestMoveTaskToTrash = vi.fn<RequestMoveTaskToTrash>(async () => {});
		const requestMoveTaskToTrashWithAnimation = vi.fn<RequestMoveTaskToTrash>(async () => {});
		const confirmMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard("trash")}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
					requestMoveTaskToTrashWithAnimation={requestMoveTaskToTrashWithAnimation}
					confirmMoveTaskToTrash={confirmMoveTaskToTrash}
					onSnapshot={(nextSnapshot) => {
						snapshot = nextSnapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(snapshot).actions.setTrashWarningState({
				open: true,
				warning: null,
				card: task,
				fromColumnId: "review",
				optimisticMoveApplied: true,
			});
		});

		const warningSnapshot = requireSnapshot(snapshot);
		await act(async () => {
			warningSnapshot.actions.handleConfirmTrashWarning();
			await Promise.resolve();
		});

		expect(confirmMoveTaskToTrash).toHaveBeenCalledWith(task, undefined, "review");
		expect(requestMoveTaskToTrashWithAnimation).not.toHaveBeenCalled();
	});
});
