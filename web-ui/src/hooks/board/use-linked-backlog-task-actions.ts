import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";

import { toast } from "sonner";
import { notifyError, showAppToast } from "@/components/app-toaster";
import type { TaskTrashWarningViewModel } from "@/components/task";
import { buildTrashWarningViewModel, getDependencyAddErrorMessage } from "@/hooks/board/linked-backlog-task-actions";
import type { UseTaskSessionsResult } from "@/hooks/board/use-task-sessions";
import { getDetailTerminalTaskId } from "@/hooks/terminal/use-terminal-panels";
import {
	addTaskDependency,
	findCardSelection,
	moveTaskToColumn,
	removeTaskDependency,
	trashTaskAndGetReadyLinkedTaskIds,
} from "@/state/board-state";
import { getTaskWorktreeInfo, getTaskWorktreeSnapshot } from "@/stores/project-metadata-store";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { createClientLogger } from "@/utils/client-logger";
import { getNextDetailTaskIdAfterTrashMove } from "@/utils/detail-view-task-order";

import type { RunTaskLifecycleOperation } from "./task-lifecycle";

const log = createClientLogger("linked-backlog-task-actions");

interface RequestMoveTaskToTrashOptions {
	optimisticMoveApplied?: boolean;
	skipWorkingChangeWarning?: boolean;
}

export function useLinkedBacklogTaskActions({
	board,
	setBoard,
	setSelectedTaskId,
	stopTaskSession,
	cleanupTaskWorktree,
	runTaskLifecycleOperation,
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
	stopTaskSession: UseTaskSessionsResult["stopTaskSession"];
	cleanupTaskWorktree: UseTaskSessionsResult["cleanupTaskWorktree"];
	runTaskLifecycleOperation: RunTaskLifecycleOperation;
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
		async (task: BoardCard, currentBoard?: BoardData): Promise<boolean> => {
			return await runTaskLifecycleOperation(task.id, async () => {
				const boardBeforeTrash = currentBoard ?? boardRef.current;
				const trashed = trashTaskAndGetReadyLinkedTaskIds(boardBeforeTrash, task.id);
				log.debug("performing task trash move", {
					taskId: task.id,
					moved: trashed.moved,
					hadCurrentBoard: !!currentBoard,
				});
				if (trashed.moved) {
					setBoard((currentBoardState) => {
						const latestTrashResult = trashTaskAndGetReadyLinkedTaskIds(currentBoardState, task.id);
						return latestTrashResult.moved ? latestTrashResult.board : currentBoardState;
					});
				} else {
					log.debug("task already in trash; cleaning up backing resources", { taskId: task.id });
				}
				setSelectedTaskId((currentSelectedTaskId) =>
					currentSelectedTaskId === task.id
						? getNextDetailTaskIdAfterTrashMove(boardBeforeTrash, task.id)
						: currentSelectedTaskId,
				);

				const readyTasks = trashed.moved
					? trashed.readyTaskIds
							.map((readyTaskId) => findCardSelection(trashed.board, readyTaskId)?.card ?? null)
							.filter((readyTask): readyTask is BoardCard => readyTask !== null)
					: [];

				if (readyTasks.length > 0) {
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

				const [stopped] = await Promise.all([
					stopTaskSession(task.id, { waitForExit: true }),
					stopTaskSession(getDetailTerminalTaskId(task.id)),
				]);
				if (!stopped.ok) {
					notifyError(stopped.error ?? "Could not stop the task session; its worktree was left in place.");
					return false;
				}
				if (task.useWorktree !== false) {
					const cleaned = await cleanupTaskWorktree(task.id);
					if (!cleaned) {
						notifyError("Could not clean up the task worktree.");
						return false;
					}
				}
				log.debug("trash cleanup complete", { taskId: task.id });
				return true;
			});
		},
		[
			cleanupTaskWorktree,
			kickoffTaskInProgress,
			runTaskLifecycleOperation,
			setBoard,
			setSelectedTaskId,
			startBacklogTaskWithAnimation,
			stopTaskSession,
			waitForBacklogStartAnimationAvailability,
		],
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
				await performMoveTaskToTrash(selection.card, boardSnapshot);
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
			const cleaned = await performMoveTaskToTrash(selection.card, boardSnapshot);

			// Show informational notice toast for manual trash from in_progress or review columns.
			// Non-isolated tasks have no worktree to delete and no patch to capture — skip the toast.
			if (
				cleaned &&
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
		confirmMoveTaskToTrash: async (task: BoardCard, currentBoard?: BoardData) => {
			await performMoveTaskToTrash(task, currentBoard);
		},
		requestMoveTaskToTrash,
	};
}
