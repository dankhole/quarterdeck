import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";

import { toast } from "sonner";
import { showAppToast } from "@/components/app-toaster";
import type { TaskTrashWarningViewModel } from "@/components/task-trash-warning-dialog";
import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import {
	addTaskDependency,
	findCardSelection,
	moveTaskToColumn,
	removeTaskDependency,
	trashTaskAndGetReadyLinkedTaskIds,
} from "@/state/board-state";
import { getTaskWorkspaceInfo, getTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { getNextDetailTaskIdAfterTrashMove } from "@/utils/detail-view-task-order";

interface RequestMoveTaskToTrashOptions {
	optimisticMoveApplied?: boolean;
	skipWorkingChangeWarning?: boolean;
}

export function useLinkedBacklogTaskActions({
	board,
	setBoard,
	setSelectedTaskId,
	stopTaskSession,
	cleanupTaskWorkspace,
	maybeRequestNotificationPermissionForTaskStart,
	kickoffTaskInProgress,
	startBacklogTaskWithAnimation,
	waitForBacklogStartAnimationAvailability,
	onRequestTrashConfirmation,
	showTrashWorktreeNotice,
	saveTrashWorktreeNoticeDismissed,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	stopTaskSession: (taskId: string, options?: { waitForExit?: boolean }) => Promise<void>;
	cleanupTaskWorkspace: (taskId: string) => Promise<unknown>;
	maybeRequestNotificationPermissionForTaskStart: () => void;
	kickoffTaskInProgress: (
		task: BoardCard,
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: { optimisticMove?: boolean },
	) => Promise<boolean>;
	startBacklogTaskWithAnimation?: (task: BoardCard) => Promise<boolean>;
	waitForBacklogStartAnimationAvailability?: () => Promise<void>;
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
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
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
				const message =
					result.reason === "same_task"
						? "A task cannot be linked to itself."
						: result.reason === "duplicate"
							? "Link already exists."
							: result.reason === "trash_task"
								? "Links cannot include trashed tasks."
								: result.reason === "non_backlog"
									? "Links must include at least one Backlog task."
									: "Could not create link.";
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message,
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
		async (task: BoardCard, currentBoard?: BoardData): Promise<void> => {
			const boardBeforeTrash = currentBoard ?? boardRef.current;
			const trashed = trashTaskAndGetReadyLinkedTaskIds(boardBeforeTrash, task.id);
			console.debug("[trash] performMoveTaskToTrash", {
				taskId: task.id,
				moved: trashed.moved,
				hadCurrentBoard: !!currentBoard,
			});
			if (!trashed.moved) {
				// Card is already in trash (e.g. optimistic drag move applied before confirmation dialog).
				// Still need to update selection and stop sessions and cleanup the workspace.
				console.debug("[trash] card already in trash, cleaning up", { taskId: task.id });
				setSelectedTaskId((currentSelectedTaskId) =>
					currentSelectedTaskId === task.id
						? getNextDetailTaskIdAfterTrashMove(boardBeforeTrash, task.id)
						: currentSelectedTaskId,
				);
				await Promise.all([
					stopTaskSession(task.id, { waitForExit: true }),
					stopTaskSession(getDetailTerminalTaskId(task.id)),
				]);
				await cleanupTaskWorkspace(task.id);
				console.debug("[trash] cleanup complete (already-in-trash path)", { taskId: task.id });
				return;
			}

			setBoard((currentBoardState) => {
				const latestTrashResult = trashTaskAndGetReadyLinkedTaskIds(currentBoardState, task.id);
				return latestTrashResult.moved ? latestTrashResult.board : currentBoardState;
			});
			setSelectedTaskId((currentSelectedTaskId) =>
				currentSelectedTaskId === task.id
					? getNextDetailTaskIdAfterTrashMove(boardBeforeTrash, task.id)
					: currentSelectedTaskId,
			);

			const readyTasks = trashed.readyTaskIds
				.map((readyTaskId) => findCardSelection(trashed.board, readyTaskId)?.card ?? null)
				.filter((readyTask): readyTask is BoardCard => readyTask !== null);

			if (readyTasks.length > 0) {
				maybeRequestNotificationPermissionForTaskStart();
				if (startBacklogTaskWithAnimation) {
					const startedTaskPromises: Promise<boolean>[] = [];
					for (const [index, readyTask] of readyTasks.entries()) {
						startedTaskPromises.push(startBacklogTaskWithAnimation(readyTask));
						if (index < readyTasks.length - 1) {
							await waitForBacklogStartAnimationAvailability?.();
						}
					}
					await Promise.all(startedTaskPromises);
				} else {
					setBoard((currentBoardState) => {
						let nextBoardState = currentBoardState;
						for (const readyTask of readyTasks) {
							const moved = moveTaskToColumn(nextBoardState, readyTask.id, "in_progress", {
								insertAtTop: true,
							});
							if (moved.moved) {
								nextBoardState = moved.board;
							}
						}
						return nextBoardState;
					});
					for (const readyTask of readyTasks) {
						await kickoffTaskInProgress(readyTask, readyTask.id, "backlog", {
							optimisticMove: true,
						});
					}
				}
			}

			await Promise.all([
				stopTaskSession(task.id, { waitForExit: true }),
				stopTaskSession(getDetailTerminalTaskId(task.id)),
			]);
			await cleanupTaskWorkspace(task.id);
		},
		[
			cleanupTaskWorkspace,
			kickoffTaskInProgress,
			maybeRequestNotificationPermissionForTaskStart,
			setBoard,
			setSelectedTaskId,
			startBacklogTaskWithAnimation,
			stopTaskSession,
			waitForBacklogStartAnimationAvailability,
		],
	);

	const requestMoveTaskToTrash = useCallback(
		async (taskId: string, fromColumnId: BoardColumnId, options?: RequestMoveTaskToTrashOptions): Promise<void> => {
			console.debug("[trash] requestMoveTaskToTrash", {
				taskId,
				fromColumnId,
				optimisticMoveApplied: !!options?.optimisticMoveApplied,
				skipWorkingChangeWarning: !!options?.skipWorkingChangeWarning,
			});
			const boardSnapshot = boardRef.current;
			const selection = findCardSelection(boardSnapshot, taskId);
			if (!selection) {
				console.debug("[trash] task not found in board, bailing", { taskId });
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

			if (options?.skipWorkingChangeWarning) {
				moveSelectionIfOptimisticMoveIsConfirmed();
				await performMoveTaskToTrash(selection.card, boardSnapshot);
				return;
			}

			// Check for uncommitted changes and show confirmation dialog if needed
			const snapshot = getTaskWorkspaceSnapshot(taskId);
			if (
				snapshot != null &&
				snapshot.changedFiles != null &&
				snapshot.changedFiles > 0 &&
				onRequestTrashConfirmation
			) {
				const workspaceInfo = getTaskWorkspaceInfo(taskId);
				const viewModel: TaskTrashWarningViewModel = {
					taskTitle: selection.card.title ?? "Untitled task",
					fileCount: snapshot.changedFiles,
					workspaceInfo,
				};
				onRequestTrashConfirmation(viewModel, selection.card, fromColumnId, !!options?.optimisticMoveApplied);
				return;
			}

			moveSelectionIfOptimisticMoveIsConfirmed();
			await performMoveTaskToTrash(selection.card, boardSnapshot);

			// Show informational notice toast for manual trash from in_progress or review columns
			if (showTrashWorktreeNotice && (fromColumnId === "in_progress" || fromColumnId === "review")) {
				toast("Task workspace removed", {
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
		confirmMoveTaskToTrash: async (task: BoardCard, currentBoard?: BoardData) => {
			await performMoveTaskToTrash(task, currentBoard);
		},
		requestMoveTaskToTrash,
	};
}
