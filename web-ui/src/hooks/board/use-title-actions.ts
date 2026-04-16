import { useCallback } from "react";
import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

interface UseTitleActionsInput {
	currentProjectId: string | null;
}

export interface UseTitleActionsResult {
	handleRegenerateTitleTask: (taskId: string) => void;
	handleUpdateTaskTitle: (taskId: string, title: string) => void;
}

export function useTitleActions({ currentProjectId }: UseTitleActionsInput): UseTitleActionsResult {
	const handleRegenerateTitleTask = useCallback(
		(taskId: string) => {
			if (!currentProjectId) {
				return;
			}
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			void trpcClient.workspace.regenerateTaskTitle.mutate({ taskId }).catch(() => {
				showAppToast({ message: "Could not regenerate title", intent: "danger" });
			});
		},
		[currentProjectId],
	);

	const handleUpdateTaskTitle = useCallback(
		(taskId: string, title: string) => {
			if (!currentProjectId) {
				return;
			}
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			void trpcClient.workspace.updateTaskTitle.mutate({ taskId, title }).catch(() => {
				showAppToast({ message: "Could not update title", intent: "danger" });
			});
		},
		[currentProjectId],
	);

	return { handleRegenerateTitleTask, handleUpdateTaskTitle };
}
