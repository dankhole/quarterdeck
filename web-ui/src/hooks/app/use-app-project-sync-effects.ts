import { useEffect } from "react";
import { useBoardMetadataSync } from "@/hooks/board";
import { useProjectMetadataVisibility } from "@/hooks/notifications";
import { useProjectSwitchCleanup } from "@/hooks/project";
import type { ProjectRuntimeStreamContextValue } from "@/providers/project-provider";
import type { CardSelection } from "@/types";

interface UseAppProjectSyncEffectsInput {
	currentProjectId: string | null;
	navigationCurrentProjectId: string | null;
	hasNoProjects: boolean;
	isProjectSwitching: boolean;
	isDocumentVisible: boolean;
	projectMetadata: ProjectRuntimeStreamContextValue["projectMetadata"];
	selectedCard: CardSelection | null;
	isHomeTerminalOpen: boolean;
	closeHomeTerminal: () => void;
	resetTaskEditorWorkflow: () => void;
	setIsClearTrashDialogOpen: (open: boolean) => void;
	resetGitActionState: () => void;
	resetProjectNavigationState: () => void;
	resetTerminalPanelsState: () => void;
	resetProjectSyncState: (targetProjectId?: string | null) => void;
}

export function useAppProjectSyncEffects({
	currentProjectId,
	navigationCurrentProjectId,
	hasNoProjects,
	isProjectSwitching,
	isDocumentVisible,
	projectMetadata,
	selectedCard,
	isHomeTerminalOpen,
	closeHomeTerminal,
	resetTaskEditorWorkflow,
	setIsClearTrashDialogOpen,
	resetGitActionState,
	resetProjectNavigationState,
	resetTerminalPanelsState,
	resetProjectSyncState,
}: UseAppProjectSyncEffectsInput): void {
	useProjectMetadataVisibility({ currentProjectId, isDocumentVisible });
	useBoardMetadataSync({ projectId: currentProjectId, projectMetadata });

	useProjectSwitchCleanup({
		currentProjectId,
		navigationCurrentProjectId,
		isProjectSwitching,
		resetTaskEditorWorkflow,
		setIsClearTrashDialogOpen,
		resetGitActionState,
		resetProjectNavigationState,
		resetTerminalPanelsState,
		resetProjectSyncState,
	});

	useEffect(() => {
		if (selectedCard) return;
		if (hasNoProjects || !currentProjectId) {
			if (isHomeTerminalOpen) closeHomeTerminal();
		}
	}, [closeHomeTerminal, currentProjectId, hasNoProjects, isHomeTerminalOpen, selectedCard]);
}
