import { useCallback, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { toErrorMessage } from "@/utils/to-error-message";

export type MigrateDirection = "isolate" | "de-isolate";

export function useMigrateWorkingDirectory(projectId: string | null) {
	const [migratingTaskId, setMigratingTaskId] = useState<string | null>(null);
	const migratingRef = useRef(false);

	const migrate = useCallback(
		async (taskId: string, direction: MigrateDirection) => {
			if (!projectId || migratingRef.current) {
				return;
			}
			migratingRef.current = true;
			setMigratingTaskId(taskId);
			try {
				const trpcClient = getRuntimeTrpcClient(projectId);
				const result = await trpcClient.runtime.migrateTaskWorkingDirectory.mutate({
					taskId,
					direction,
				});
				if (!result.ok) {
					showAppToast({ intent: "danger", message: result.error ?? "Migration failed." });
				} else {
					showAppToast({
						intent: "success",
						message: direction === "isolate" ? "Task isolated to worktree." : "Task moved to main checkout.",
					});
				}
			} catch (error) {
				const message = toErrorMessage(error);
				showAppToast({ intent: "danger", message });
			} finally {
				migratingRef.current = false;
				setMigratingTaskId(null);
			}
		},
		[projectId],
	);

	return { migrate, migratingTaskId };
}
