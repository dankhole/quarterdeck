import { useCallback } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { UseTaskLifecycleOperationsResult } from "@/hooks/board/use-task-lifecycle-operations";
import type { BoardCard, BoardColumnId } from "@/types";

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
	return !agentId || !resumeSessionId;
}

interface UseTaskLifecycleInput {
	executeTaskLifecycle: UseTaskLifecycleOperationsResult["executeTaskLifecycle"];
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

/**
 * Presentation adapter for board animations. Durable board movement, process
 * control, worktree mutation, compensation, and replay all belong to the
 * runtime lifecycle service.
 */
export function useTaskLifecycle({ executeTaskLifecycle }: UseTaskLifecycleInput): UseTaskLifecycleResult {
	const kickoffTaskInProgress = useCallback(
		async (task: BoardCard, taskId: string, fromColumnId: BoardColumnId): Promise<boolean> => {
			if (fromColumnId !== "backlog" || task.id !== taskId) {
				return false;
			}
			const result = await executeTaskLifecycle({
				kind: "start",
				taskId,
				taskCreatedAt: task.createdAt,
			});
			return result?.ok === true;
		},
		[executeTaskLifecycle],
	);

	const resumeTaskFromTrash = useCallback(
		async (task: BoardCard, taskId: string): Promise<void> => {
			if (task.id !== taskId) {
				return;
			}
			const result = await executeTaskLifecycle({
				kind: "restore",
				taskId,
				taskCreatedAt: task.createdAt,
			});
			if (
				result?.ok &&
				task.useWorktree === false &&
				shouldWarnForNonIsolatedResume(result.summary?.agentId, result.summary?.resumeSessionId)
			) {
				showNonIsolatedResumeWarning();
			}
		},
		[executeTaskLifecycle],
	);

	return { kickoffTaskInProgress, resumeTaskFromTrash };
}
