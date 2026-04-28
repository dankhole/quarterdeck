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
				console.warn("[title-actions] regenerate skipped: no current project", { taskId });
				return;
			}
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			void trpcClient.project.regenerateTaskTitle
				.mutate({ taskId })
				.then((result) => {
					if (!result.ok) {
						console.warn(
							"[title-actions] regenerate returned ok=false — server could not generate a title (LLM unconfigured, rate-limited, timed out, empty, or sanitizer-rejected; check runtime logs tagged 'title-gen' / 'llm-client')",
							{ taskId, projectId: currentProjectId, result },
						);
						showAppToast({ message: "Could not regenerate title", intent: "danger" });
					}
				})
				.catch((err: unknown) => {
					console.error("[title-actions] regenerate mutation threw", {
						taskId,
						projectId: currentProjectId,
						error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
					});
					showAppToast({ message: "Could not regenerate title", intent: "danger" });
				});
		},
		[currentProjectId],
	);

	const handleUpdateTaskTitle = useCallback(
		(taskId: string, title: string) => {
			if (!currentProjectId) {
				console.warn("[title-actions] update skipped: no current project", { taskId });
				return;
			}
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			void trpcClient.project.updateTaskTitle.mutate({ taskId, title }).catch((err: unknown) => {
				console.error("[title-actions] update mutation threw", {
					taskId,
					projectId: currentProjectId,
					titleLength: title.length,
					error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
				});
				showAppToast({ message: "Could not update title", intent: "danger" });
			});
		},
		[currentProjectId],
	);

	return { handleRegenerateTitleTask, handleUpdateTaskTitle };
}
