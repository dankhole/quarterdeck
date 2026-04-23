import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import type { UseTaskSessionsResult } from "@/hooks/board/use-task-sessions";
import type { RuntimeTaskWorktreeInfoResponse } from "@/runtime/types";
import { disableTaskAutoReview } from "@/state/board-state";
import { setTaskWorktreeInfo } from "@/stores/project-metadata-store";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

import {
	applyDeferredMoveToInProgress,
	buildWorktreeInfoFromEnsureResponse,
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

export function shouldWarnForNonIsolatedResume(
	agentId: string | null | undefined,
	resumeSessionId: string | null | undefined,
): boolean {
	return agentId !== "codex" || !resumeSessionId;
}

interface UseTaskLifecycleInput {
	setBoard: Dispatch<SetStateAction<BoardData>>;
	selectedTaskId: string | null;
	stopTaskSession: (taskId: string, options?: { waitForExit?: boolean }) => Promise<void>;
	ensureTaskWorktree: UseTaskSessionsResult["ensureTaskWorktree"];
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	fetchTaskWorktreeInfo: (task: BoardCard) => Promise<RuntimeTaskWorktreeInfoResponse | null>;
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
	stopTaskSession,
	ensureTaskWorktree,
	startTaskSession,
	fetchTaskWorktreeInfo,
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
				const ensured = await ensureTaskWorktree(task);
				if (!ensured.ok) {
					notifyError(ensured.message ?? "Could not set up task worktree.");
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
						setTaskWorktreeInfo(buildWorktreeInfoFromEnsureResponse(taskId, ensured.response));
					}
					const infoAfterEnsure = await fetchTaskWorktreeInfo(task);
					if (infoAfterEnsure) {
						setTaskWorktreeInfo(infoAfterEnsure);
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
		[ensureTaskWorktree, fetchTaskWorktreeInfo, selectedTaskId, setBoard, startTaskSession],
	);

	const resumeTaskFromTrash = useCallback(
		async (task: BoardCard, taskId: string, options?: { optimisticMoveApplied?: boolean }): Promise<void> => {
			const revertToTrash = () => {
				if (!options?.optimisticMoveApplied) {
					return;
				}
				setBoard((board) => revertOptimisticMoveToReview(board, taskId) ?? board);
			};

			// Trashing waits for the old task session to exit, but restore can race if the
			// user untrashes before that stop fully settles. Force the previous session to
			// finish exiting before we ask the runtime to resume the conversation.
			await stopTaskSession(taskId, { waitForExit: true });

			// Non-isolated tasks run in the home repo — no worktree to ensure.
			if (!isNonIsolatedTask(task)) {
				const ensured = await ensureTaskWorktree(task);
				if (!ensured.ok) {
					notifyError(ensured.message ?? "Could not set up task worktree.");
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
				if (
					isNonIsolatedTask(task) &&
					shouldWarnForNonIsolatedResume(resumed.summary?.agentId, resumed.summary?.resumeSessionId)
				) {
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
		[ensureTaskWorktree, setBoard, startTaskSession, stopTaskSession],
	);

	return { kickoffTaskInProgress, resumeTaskFromTrash };
}
