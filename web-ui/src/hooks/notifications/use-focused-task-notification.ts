import { useEffect } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

interface UseFocusedTaskNotificationInput {
	currentProjectId: string | null;
	selectedTaskId: string | null;
}

/**
 * Notifies the runtime which task is focused so it can prioritize git polling
 * for that task's worktree.
 */
export function useFocusedTaskNotification({
	currentProjectId,
	selectedTaskId,
}: UseFocusedTaskNotificationInput): void {
	useEffect(() => {
		if (!currentProjectId || selectedTaskId === null) {
			return;
		}
		getRuntimeTrpcClient(currentProjectId)
			.workspace.setFocusedTask.mutate({ taskId: selectedTaskId })
			.catch(() => {
				// Fire-and-forget — polling priority is non-critical.
			});
	}, [currentProjectId, selectedTaskId]);
}
