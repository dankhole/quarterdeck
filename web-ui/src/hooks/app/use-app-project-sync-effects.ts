import type { Dispatch, SetStateAction } from "react";
import { useEffect } from "react";
import { useBoardMetadataSync, useTaskBaseRefSync, useTaskTitleSync } from "@/hooks/board";
import { useProjectMetadataVisibility } from "@/hooks/notifications";
import { useProjectSwitchCleanup } from "@/hooks/project";
import type { ProjectRuntimeStreamContextValue } from "@/providers/project-provider";
import type { BoardData, CardSelection } from "@/types";

interface UseAppProjectSyncEffectsInput {
	currentProjectId: string | null;
	navigationCurrentProjectId: string | null;
	hasNoProjects: boolean;
	isProjectSwitching: boolean;
	isDocumentVisible: boolean;
	projectMetadata: ProjectRuntimeStreamContextValue["projectMetadata"];
	latestTaskTitleUpdate: ProjectRuntimeStreamContextValue["latestTaskTitleUpdate"];
	latestTaskBaseRefUpdate: ProjectRuntimeStreamContextValue["latestTaskBaseRefUpdate"];
	selectedCard: CardSelection | null;
	isHomeTerminalOpen: boolean;
	closeHomeTerminal: () => void;
	setBoard: Dispatch<SetStateAction<BoardData>>;
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
	latestTaskTitleUpdate,
	latestTaskBaseRefUpdate,
	selectedCard,
	isHomeTerminalOpen,
	closeHomeTerminal,
	setBoard,
	resetTaskEditorWorkflow,
	setIsClearTrashDialogOpen,
	resetGitActionState,
	resetProjectNavigationState,
	resetTerminalPanelsState,
	resetProjectSyncState,
}: UseAppProjectSyncEffectsInput): void {
	useProjectMetadataVisibility({ currentProjectId, isDocumentVisible });
	useBoardMetadataSync({ projectMetadata, setBoard });
	useTaskTitleSync({ latestTaskTitleUpdate, setBoard });
	useTaskBaseRefSync({ latestTaskBaseRefUpdate, setBoard });

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
