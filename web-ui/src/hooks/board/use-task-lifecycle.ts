import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import type { UseTaskSessionsResult } from "@/hooks/board/use-task-sessions";
import type { RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { disableTaskAutoReview, getTaskColumnId, moveTaskToColumn } from "@/state/board-state";
import { setTaskWorkspaceInfo } from "@/stores/workspace-metadata-store";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

export function showNonIsolatedResumeWarning(): void {
	showAppToast({
		intent: "warning",
		icon: "info-sign",
		message:
			"Non-isolated tasks resume the most recent agent session in this repo. If other agents have run here, this may not be the original conversation.",
		timeout: 9000,
	});
}

interface UseTaskLifecycleInput {
	setBoard: Dispatch<SetStateAction<BoardData>>;
	selectedTaskId: string | null;
	ensureTaskWorkspace: UseTaskSessionsResult["ensureTaskWorkspace"];
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
}

export interface UseTaskLifecycleResult {
	kickoffTaskInProgress: (
		task: BoardCard,
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: { optimisticMove?: boolean },
	) => Promise<boolean>;
	resumeTaskFromTrash: (
		task: BoardCard,
		taskId: string,
		options?: { optimisticMoveApplied?: boolean },
	) => Promise<void>;
}

export function useTaskLifecycle({
	setBoard,
	selectedTaskId,
	ensureTaskWorkspace,
	startTaskSession,
	fetchTaskWorkspaceInfo,
}: UseTaskLifecycleInput): UseTaskLifecycleResult {
	const kickoffTaskInProgress = useCallback(
		async (
			task: BoardCard,
			taskId: string,
			fromColumnId: BoardColumnId,
			options?: { optimisticMove?: boolean },
		): Promise<boolean> => {
			const optimisticMove = options?.optimisticMove ?? true;
			const isNonIsolated = task.useWorktree === false;

			// Non-isolated tasks run in the home repo — no worktree to ensure.
			// Calling ensureTaskWorkspace would create an orphan worktree on disk.
			if (!isNonIsolated) {
				const ensured = await ensureTaskWorkspace(task);
				if (!ensured.ok) {
					notifyError(ensured.message ?? "Could not set up task workspace.");
					if (optimisticMove) {
						setBoard((currentBoard) => {
							const currentColumnId = getTaskColumnId(currentBoard, taskId);
							if (currentColumnId !== "in_progress") {
								return currentBoard;
							}
							const reverted = moveTaskToColumn(currentBoard, taskId, fromColumnId);
							return reverted.moved ? reverted.board : currentBoard;
						});
					}
					return false;
				}
				if (ensured.response?.warning) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: ensured.response.warning,
						timeout: 7000,
					});
				}
				if (selectedTaskId === taskId) {
					if (ensured.response) {
						setTaskWorkspaceInfo({
							taskId,
							path: ensured.response.path,
							exists: true,
							baseRef: ensured.response.baseRef,
							branch: ensured.response.branch ?? null,
							isDetached: !ensured.response.branch,
							headCommit: ensured.response.baseCommit,
						});
					}
					const infoAfterEnsure = await fetchTaskWorkspaceInfo(task);
					if (infoAfterEnsure) {
						setTaskWorkspaceInfo(infoAfterEnsure);
					}
				}
			}

			const started = await startTaskSession(task);
			if (!started.ok) {
				notifyError(started.message ?? "Could not start task session.");
				if (optimisticMove) {
					setBoard((currentBoard) => {
						const currentColumnId = getTaskColumnId(currentBoard, taskId);
						if (currentColumnId !== "in_progress") {
							return currentBoard;
						}
						const reverted = moveTaskToColumn(currentBoard, taskId, fromColumnId);
						return reverted.moved ? reverted.board : currentBoard;
					});
				}
				return false;
			}
			if (!optimisticMove) {
				setBoard((currentBoard) => {
					const currentColumnId = getTaskColumnId(currentBoard, taskId);
					if (currentColumnId !== fromColumnId) {
						return currentBoard;
					}
					const moved = moveTaskToColumn(currentBoard, taskId, "in_progress", { insertAtTop: true });
					return moved.moved ? moved.board : currentBoard;
				});
			}
			return true;
		},
		[ensureTaskWorkspace, fetchTaskWorkspaceInfo, selectedTaskId, setBoard, startTaskSession],
	);

	const resumeTaskFromTrash = useCallback(
		async (task: BoardCard, taskId: string, options?: { optimisticMoveApplied?: boolean }): Promise<void> => {
			const isNonIsolated = task.useWorktree === false;

			const revertToTrash = () => {
				if (!options?.optimisticMoveApplied) {
					return;
				}
				setBoard((currentBoard) => {
					const currentColumnId = getTaskColumnId(currentBoard, taskId);
					if (currentColumnId !== "review") {
						return currentBoard;
					}
					const reverted = moveTaskToColumn(currentBoard, taskId, "trash", {
						insertAtTop: true,
					});
					return reverted.moved ? reverted.board : currentBoard;
				});
			};

			// Non-isolated tasks run in the home repo — no worktree to ensure.
			// Calling ensureTaskWorkspace would create an unwanted worktree.
			if (!isNonIsolated) {
				const ensured = await ensureTaskWorkspace(task);
				if (!ensured.ok) {
					notifyError(ensured.message ?? "Could not set up task workspace.");
					revertToTrash();
					return;
				}
				if (ensured.response?.warning) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: ensured.response.warning,
						timeout: 7000,
					});
				}
			}

			const resumed = await startTaskSession(task, { resumeConversation: true, awaitReview: true });
			if (resumed.ok) {
				if (isNonIsolated) {
					showNonIsolatedResumeWarning();
				}
				setBoard((currentBoard) => {
					const disabledAutoReview = disableTaskAutoReview(currentBoard, taskId);
					return disabledAutoReview.updated ? disabledAutoReview.board : currentBoard;
				});
				return;
			}

			notifyError(resumed.message ?? "Could not resume task session.");
			revertToTrash();
		},
		[ensureTaskWorkspace, setBoard, startTaskSession],
	);

	return { kickoffTaskInProgress, resumeTaskFromTrash };
}
