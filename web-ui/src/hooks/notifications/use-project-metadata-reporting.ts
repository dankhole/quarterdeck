import { useEffect, useRef } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

interface UseProjectMetadataReportingInput {
	currentProjectId: string | null;
	selectedTaskId: string | null;
	isDocumentVisible: boolean;
	enabled: boolean;
}

/** Reports browser focus and visibility so the runtime can prioritize metadata polling. */
export function useProjectMetadataReporting({
	currentProjectId,
	selectedTaskId,
	isDocumentVisible,
	enabled,
}: UseProjectMetadataReportingInput): void {
	const enabledRef = useRef(enabled);
	useEffect(() => {
		// Cleanup precedes the next project's effects and reads the admission
		// state last committed for the project it is leaving.
		enabledRef.current = enabled;
	}, [currentProjectId, enabled]);

	useEffect(() => {
		if (!currentProjectId || !enabled) return;
		getRuntimeTrpcClient(currentProjectId)
			.project.setFocusedTask.mutate({ taskId: selectedTaskId })
			.catch(() => {
				// Polling priority is non-critical.
			});
	}, [currentProjectId, enabled, selectedTaskId]);

	useEffect(() => {
		if (!currentProjectId || !enabled) return;
		getRuntimeTrpcClient(currentProjectId)
			.project.setDocumentVisible.mutate({ isDocumentVisible })
			.catch(() => {
				// Visibility only tunes metadata polling policy.
			});
	}, [currentProjectId, enabled, isDocumentVisible]);

	useEffect(() => {
		if (!currentProjectId) return;
		return () => {
			if (!enabledRef.current) return;
			const client = getRuntimeTrpcClient(currentProjectId).project;
			Promise.all([
				client.setFocusedTask.mutate({ taskId: null }),
				client.setDocumentVisible.mutate({ isDocumentVisible: false }),
			]).catch(() => {
				// Cleanup only tunes metadata polling policy.
			});
		};
	}, [currentProjectId]);
}
