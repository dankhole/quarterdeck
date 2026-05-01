import type { MutableRefObject } from "react";
import { useCallback } from "react";
import { showAppToast } from "@/components/app-toaster";
import { saveProjectState } from "@/runtime/project-state-query";
import { useProjectPersistence } from "@/runtime/use-project-persistence";
import type { BoardData } from "@/types";

interface UseAppProjectPersistenceEffectsInput {
	board: BoardData;
	currentProjectId: string | null;
	projectRevision: number | null;
	hydrationNonce: number;
	shouldSkipPersistOnHydration: boolean;
	canPersistProjectState: boolean;
	isDocumentVisible: boolean;
	isProjectStateRefreshing: boolean;
	refetchProjectState: () => Promise<void>;
	onProjectRevisionChange: (revision: number | null) => void;
	serverMutationInFlightRef: MutableRefObject<boolean>;
}

export function useAppProjectPersistenceEffects({
	board,
	currentProjectId,
	projectRevision,
	hydrationNonce,
	shouldSkipPersistOnHydration,
	canPersistProjectState,
	isDocumentVisible,
	isProjectStateRefreshing,
	refetchProjectState,
	onProjectRevisionChange,
	serverMutationInFlightRef,
}: UseAppProjectPersistenceEffectsInput): void {
	const persistProjectStateAsync = useCallback(
		async (input: { projectId: string; payload: Parameters<typeof saveProjectState>[1] }) =>
			await saveProjectState(input.projectId, input.payload),
		[],
	);

	const handleProjectStateConflict = useCallback(() => {
		if (serverMutationInFlightRef.current) return;
		showAppToast(
			{
				intent: "warning",
				icon: "warning-sign",
				message:
					"Project changed elsewhere (e.g. another tab). Synced latest state. Retry your last edit if needed.",
				timeout: 5000,
			},
			"project-state-conflict",
		);
	}, [serverMutationInFlightRef]);

	useProjectPersistence({
		board,
		currentProjectId,
		projectRevision,
		hydrationNonce,
		shouldSkipPersistOnHydration,
		canPersistProjectState,
		isDocumentVisible,
		isProjectStateRefreshing,
		persistProjectState: persistProjectStateAsync,
		refetchProjectState,
		onProjectRevisionChange,
		onProjectStateConflict: handleProjectStateConflict,
	});
}
