import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";

import { toast } from "sonner";
import { showAppToast } from "@/components/app-toaster";
import type { TaskTrashWarningViewModel } from "@/components/task";
import { buildTrashWarningViewModel, getDependencyAddErrorMessage } from "@/hooks/board/linked-backlog-task-actions";
import type { UseTaskLifecycleOperationsResult } from "@/hooks/board/use-task-lifecycle-operations";
import {
	addTaskDependency,
	findCardSelection,
	removeTaskDependency,
	trashTaskAndGetReadyLinkedTaskIds,
} from "@/state/board-state";
import { getTaskWorktreeInfo, getTaskWorktreeSnapshot } from "@/stores/project-metadata-store";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { createClientLogger } from "@/utils/client-logger";
import { getNextDetailTaskIdAfterTrashMove } from "@/utils/detail-view-task-order";

const log = createClientLogger("linked-backlog-task-actions");

interface RequestMoveTaskToTrashOptions {
	optimisticMoveApplied?: boolean;
	skipWorkingChangeWarning?: boolean;
}

export function useLinkedBacklogTaskActions({
	board,
	setBoard,
	presentLifecycleBoard,
	setSelectedTaskId,
	executeTaskLifecycle,
	onRequestTrashConfirmation,
	showTrashWorktreeNotice,
	saveTrashWorktreeNoticeDismissed,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	presentLifecycleBoard: Dispatch<SetStateAction<BoardData>>;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	executeTaskLifecycle: UseTaskLifecycleOperationsResult["executeTaskLifecycle"];
	onRequestTrashConfirmation?: (
		viewModel: TaskTrashWarningViewModel,
		card: BoardCard,
		fromColumnId: BoardColumnId,
		optimisticMoveApplied: boolean,
	) => void;
	showTrashWorktreeNotice?: boolean;
	saveTrashWorktreeNoticeDismissed?: () => void;
}): {
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	handleDeleteDependency: (dependencyId: string) => void;
	confirmMoveTaskToTrash: (
		task: BoardCard,
		currentBoard?: BoardData,
		sourceColumnId?: Exclude<BoardColumnId, "trash">,
	) => Promise<void>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: RequestMoveTaskToTrashOptions,
	) => Promise<void>;
} {
	const boardRef = useRef(board);

	useEffect(() => {
		boardRef.current = board;
	}, [board]);

	const handleCreateDependency = useCallback(
		(fromTaskId: string, toTaskId: string) => {
			const result = addTaskDependency(boardRef.current, fromTaskId, toTaskId);
			if (!result.added) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: getDependencyAddErrorMessage(result.reason),
					timeout: 3000,
				});
				return;
			}

			setBoard((currentBoard) => {
				const latestResult = addTaskDependency(currentBoard, fromTaskId, toTaskId);
				return latestResult.added ? latestResult.board : currentBoard;
			});
		},
		[setBoard],
	);

	const handleDeleteDependency = useCallback(
		(dependencyId: string) => {
			setBoard((currentBoard) => {
				const removed = removeTaskDependency(currentBoard, dependencyId);
				return removed.removed ? removed.board : currentBoard;
			});
		},
		[setBoard],
	);

	const performMoveTaskToTrash = useCallback(
		async (
			task: BoardCard,
			currentBoard?: BoardData,
			sourceColumnId?: Exclude<BoardColumnId, "trash">,
		): Promise<boolean> => {
			const boardBeforeTrash = currentBoard ?? boardRef.current;
			const resolvedSourceColumnId = sourceColumnId ?? findCardSelection(boardBeforeTrash, task.id)?.column.id;
			if (!resolvedSourceColumnId || resolvedSourceColumnId === "trash") {
				log.warn("task trash move skipped because its source column was unavailable", { taskId: task.id });
				return false;
			}
			const trashed = trashTaskAndGetReadyLinkedTaskIds(boardBeforeTrash, task.id);
			log.debug("performing task trash move", {
				taskId: task.id,
				moved: trashed.moved,
				hadCurrentBoard: !!currentBoard,
			});
			if (trashed.moved) {
				presentLifecycleBoard((currentBoardState) => {
					const latestTrashResult = trashTaskAndGetReadyLinkedTaskIds(currentBoardState, task.id);
					return latestTrashResult.moved ? latestTrashResult.board : currentBoardState;
				});
			}
			setSelectedTaskId((currentSelectedTaskId) =>
				currentSelectedTaskId === task.id
					? getNextDetailTaskIdAfterTrashMove(boardBeforeTrash, task.id)
					: currentSelectedTaskId,
			);
			const result = await executeTaskLifecycle({
				kind: "trash",
				taskId: task.id,
				taskCreatedAt: task.createdAt,
				sourceColumnId: resolvedSourceColumnId,
			});
			return result?.ok === true;
		},
		[executeTaskLifecycle, presentLifecycleBoard, setSelectedTaskId],
	);

	const requestMoveTaskToTrash = useCallback(
		async (taskId: string, fromColumnId: BoardColumnId, options?: RequestMoveTaskToTrashOptions): Promise<void> => {
			log.debug("task trash move requested", {
				taskId,
				fromColumnId,
				optimisticMoveApplied: !!options?.optimisticMoveApplied,
				skipWorkingChangeWarning: !!options?.skipWorkingChangeWarning,
			});
			const boardSnapshot = boardRef.current;
			const selection = findCardSelection(boardSnapshot, taskId);
			if (!selection) {
				log.debug("task trash move skipped because task was not found", { taskId });
				return;
			}

			const moveSelectionIfOptimisticMoveIsConfirmed = () => {
				if (!options?.optimisticMoveApplied) {
					return;
				}
				setSelectedTaskId((currentSelectedTaskId) =>
					currentSelectedTaskId === taskId
						? getNextDetailTaskIdAfterTrashMove(boardSnapshot, taskId)
						: currentSelectedTaskId,
				);
			};

			const isNonIsolated = selection.card.useWorktree === false;

			if (options?.skipWorkingChangeWarning) {
				moveSelectionIfOptimisticMoveIsConfirmed();
				if (fromColumnId !== "trash") {
					await performMoveTaskToTrash(selection.card, boardSnapshot, fromColumnId);
				}
				return;
			}

			// Always show confirmation dialog before trashing
			if (onRequestTrashConfirmation) {
				const snapshot = getTaskWorktreeSnapshot(taskId);
				const worktreeInfo = getTaskWorktreeInfo(taskId);
				const viewModel = buildTrashWarningViewModel(selection.card, snapshot?.changedFiles ?? 0, worktreeInfo);
				onRequestTrashConfirmation(viewModel, selection.card, fromColumnId, !!options?.optimisticMoveApplied);
				return;
			}

			moveSelectionIfOptimisticMoveIsConfirmed();
			if (fromColumnId === "trash") {
				return;
			}
			const movedToTrash = await performMoveTaskToTrash(selection.card, boardSnapshot, fromColumnId);

			// Show informational notice toast for manual trash from in_progress or review columns.
			// Non-isolated tasks have no worktree to delete and no patch to capture — skip the toast.
			if (
				movedToTrash &&
				!isNonIsolated &&
				showTrashWorktreeNotice &&
				(fromColumnId === "in_progress" || fromColumnId === "review")
			) {
				toast("Task worktree removed", {
					description: "The worktree was deleted. Uncommitted work was captured in a patch file.",
					duration: 7000,
					className: "toast-with-dismiss-link",
					cancel: {
						label: "Don't show again",
						onClick: () => {
							saveTrashWorktreeNoticeDismissed?.();
						},
					},
				});
			}
		},
		[
			onRequestTrashConfirmation,
			performMoveTaskToTrash,
			saveTrashWorktreeNoticeDismissed,
			setSelectedTaskId,
			showTrashWorktreeNotice,
		],
	);

	return {
		handleCreateDependency,
		handleDeleteDependency,
		confirmMoveTaskToTrash: async (
			task: BoardCard,
			currentBoard?: BoardData,
			sourceColumnId?: Exclude<BoardColumnId, "trash">,
		) => {
			await performMoveTaskToTrash(task, currentBoard, sourceColumnId);
		},
		requestMoveTaskToTrash,
	};
}
