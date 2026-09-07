import { useCallback, useRef } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import type { FlushProjectBoardCommandsResult } from "@/hooks/project/use-project-sync";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeClearTrashRequest, RuntimeClearTrashResult, RuntimeProjectStateResponse } from "@/runtime/types";
import { sendClearTrashRequest, summarizeClearTrash } from "./clear-trash-operation";
import { createTaskLifecycleOperationId } from "./task-lifecycle-operations";

export type ClearTrash = (tasks: RuntimeClearTrashRequest["tasks"]) => Promise<RuntimeClearTrashResult | null>;

export function useClearTrashOperation({
	currentProjectId,
	flushBoardCommands,
	getAuthoritativeRevision,
	applyLifecycleProjectState,
}: {
	currentProjectId: string | null;
	flushBoardCommands: () => Promise<FlushProjectBoardCommandsResult>;
	getAuthoritativeRevision: () => number | null;
	applyLifecycleProjectState: (state: RuntimeProjectStateResponse) => void;
}): ClearTrash {
	const inFlight = useRef(new Map<string, Promise<RuntimeClearTrashResult | null>>());
	return useCallback(
		async (tasks) => {
			if (!currentProjectId || tasks.length === 0) return null;
			const existing = inFlight.current.get(currentProjectId);
			if (existing) return existing;
			const initialRevision = getAuthoritativeRevision();
			if (initialRevision === null) {
				notifyError("The project is still loading. Try the action again.");
				return null;
			}
			const projectId = currentProjectId;
			const operationId = createTaskLifecycleOperationId("delete");
			const taskIdentities = tasks.map((task) => ({ ...task }));
			const promise = (async () => {
				showAppToast(
					{
						message: `Clearing ${tasks.length} task${tasks.length === 1 ? "" : "s"} from Trash…`,
						timeout: Infinity,
					},
					operationId,
				);
				try {
					const flushed = await flushBoardCommands();
					if (!flushed.ok) throw new Error(flushed.message ?? "Could not save pending board changes.");
					// The captured origin revision remains valid for identity-checked server rebasing after navigation.
					const expectedRevision = initialRevision;
					const request = { operationId, expectedRevision, tasks: taskIdentities };
					const client = getRuntimeTrpcClient(projectId);
					const result = await sendClearTrashRequest(request, (input) => client.runtime.clearTrash.mutate(input));
					applyLifecycleProjectState(result.state);
					const { message, failed } = summarizeClearTrash(result);
					showAppToast(
						{
							intent: failed > 0 ? "warning" : "success",
							message,
							timeout: failed > 0 ? 10000 : 5000,
						},
						operationId,
					);
					return result;
				} catch (error) {
					notifyError(
						error instanceof Error
							? error.message
							: "Could not confirm Clear Trash. Check Trash before trying again.",
						{ key: operationId },
					);
					return null;
				}
			})();
			inFlight.current.set(projectId, promise);
			try {
				return await promise;
			} finally {
				inFlight.current.delete(projectId);
			}
		},
		[currentProjectId, flushBoardCommands, getAuthoritativeRevision, applyLifecycleProjectState],
	);
}
