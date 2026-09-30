import { useEffect } from "react";
import { useBoardMetadataSync } from "@/hooks/board";
import { useProjectSwitchCleanup } from "@/hooks/project";
import type { ProjectRuntimeStreamContextValue } from "@/providers/project-provider";
import type { CardSelection } from "@/types";

interface UseAppProjectSyncEffectsInput {
	currentProjectId: string | null;
	projectPath: string | null;
	isProjectUnavailable?: boolean;
	navigationCurrentProjectId: string | null;
	hasNoProjects: boolean;
	isProjectSwitching: boolean;
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
	projectPath,
	isProjectUnavailable = false,
	navigationCurrentProjectId,
	hasNoProjects,
	isProjectSwitching,
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
	useBoardMetadataSync({ projectId: currentProjectId, projectMetadata });

	useProjectSwitchCleanup({
		currentProjectId,
		projectPath,
		isProjectUnavailable,
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
