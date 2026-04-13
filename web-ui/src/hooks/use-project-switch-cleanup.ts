import type { Dispatch, SetStateAction } from "react";
import { useEffect } from "react";
import { resetWorkspaceMetadataStore } from "@/stores/workspace-metadata-store";

interface UseProjectSwitchCleanupInput {
	currentProjectId: string | null;
	isProjectSwitching: boolean;
	resetTaskEditorState: () => void;
	setIsClearTrashDialogOpen: Dispatch<SetStateAction<boolean>>;
	resetGitActionState: () => void;
	resetProjectNavigationState: () => void;
	resetTerminalPanelsState: () => void;
	resetWorkspaceSyncState: () => void;
}

/**
 * Consolidates the scattered effects that reset various UI state when the
 * active project changes or a project switch is in progress.
 */
export function useProjectSwitchCleanup({
	currentProjectId,
	isProjectSwitching,
	resetTaskEditorState,
	setIsClearTrashDialogOpen,
	resetGitActionState,
	resetProjectNavigationState,
	resetTerminalPanelsState,
	resetWorkspaceSyncState,
}: UseProjectSwitchCleanupInput): void {
	// Reset workspace metadata store when switching projects.
	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceMetadataStore();
	}, [isProjectSwitching]);

	// Reset workspace sync state when switching projects.
	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceSyncState();
	}, [isProjectSwitching, resetWorkspaceSyncState]);

	// Reset task editor state when switching projects.
	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetTaskEditorState();
	}, [isProjectSwitching, resetTaskEditorState]);

	// Reset all transient state when the current project changes.
	useEffect(() => {
		resetTaskEditorState();
		setIsClearTrashDialogOpen(false);
		resetGitActionState();
		resetProjectNavigationState();
		resetTerminalPanelsState();
	}, [
		currentProjectId,
		resetGitActionState,
		resetProjectNavigationState,
		resetTaskEditorState,
		resetTerminalPanelsState,
		setIsClearTrashDialogOpen,
	]);
}
