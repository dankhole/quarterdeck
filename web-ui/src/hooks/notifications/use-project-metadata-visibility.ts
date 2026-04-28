import { useEffect } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

interface UseProjectMetadataVisibilityInput {
	currentProjectId: string | null;
	isDocumentVisible: boolean;
}

/**
 * Notifies the runtime when the browser can benefit from fresh git metadata.
 */
export function useProjectMetadataVisibility({
	currentProjectId,
	isDocumentVisible,
}: UseProjectMetadataVisibilityInput): void {
	useEffect(() => {
		if (!currentProjectId) {
			return;
		}
		getRuntimeTrpcClient(currentProjectId)
			.project.setDocumentVisible.mutate({ isDocumentVisible })
			.catch(() => {
				// Fire-and-forget — visibility only tunes metadata polling policy.
			});
	}, [currentProjectId, isDocumentVisible]);

	useEffect(() => {
		if (!currentProjectId) {
			return;
		}
		return () => {
			getRuntimeTrpcClient(currentProjectId)
				.project.setDocumentVisible.mutate({ isDocumentVisible: false })
				.catch(() => {
					// Fire-and-forget — visibility only tunes metadata polling policy.
				});
		};
	}, [currentProjectId]);
}
