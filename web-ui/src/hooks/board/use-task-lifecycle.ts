import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import type { UseTaskSessionsResult } from "@/hooks/board/use-task-sessions";
import type { RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { disableTaskAutoReview } from "@/state/board-state";
import { setTaskWorkspaceInfo } from "@/stores/workspace-metadata-store";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

import {
	applyDeferredMoveToInProgress,
	buildWorkspaceInfoFromEnsureResponse,
	isNonIsolatedTask,
	revertOptimisticMoveToInProgress,
	revertOptimisticMoveToReview,
} from "./task-lifecycle";

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

			// Non-isolated tasks run in the home repo — no worktree to ensure.
			if (!isNonIsolatedTask(task)) {
				const ensured = await ensureTaskWorkspace(task);
				if (!ensured.ok) {
					notifyError(ensured.message ?? "Could not set up task workspace.");
					if (optimisticMove) {
						setBoard((board) => revertOptimisticMoveToInProgress(board, taskId, fromColumnId) ?? board);
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
						setTaskWorkspaceInfo(buildWorkspaceInfoFromEnsureResponse(taskId, ensured.response));
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
					setBoard((board) => revertOptimisticMoveToInProgress(board, taskId, fromColumnId) ?? board);
				}
				return false;
			}
			if (!optimisticMove) {
				setBoard((board) => applyDeferredMoveToInProgress(board, taskId, fromColumnId) ?? board);
			}
			return true;
		},
		[ensureTaskWorkspace, fetchTaskWorkspaceInfo, selectedTaskId, setBoard, startTaskSession],
	);

	const resumeTaskFromTrash = useCallback(
		async (task: BoardCard, taskId: string, options?: { optimisticMoveApplied?: boolean }): Promise<void> => {
			const revertToTrash = () => {
				if (!options?.optimisticMoveApplied) {
					return;
				}
				setBoard((board) => revertOptimisticMoveToReview(board, taskId) ?? board);
			};

			// Non-isolated tasks run in the home repo — no worktree to ensure.
			if (!isNonIsolatedTask(task)) {
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
				if (isNonIsolatedTask(task)) {
					showNonIsolatedResumeWarning();
				}
				setBoard((board) => {
					const result = disableTaskAutoReview(board, taskId);
					return result.updated ? result.board : board;
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
