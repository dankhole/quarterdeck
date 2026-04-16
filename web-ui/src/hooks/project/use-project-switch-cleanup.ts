import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import { resetWorkspaceMetadataStore } from "@/stores/workspace-metadata-store";
import { disposeAllDedicatedTerminalsForWorkspace, releaseAll } from "@/terminal/terminal-pool";

interface UseProjectSwitchCleanupInput {
	currentProjectId: string | null;
	navigationCurrentProjectId: string | null;
	isProjectSwitching: boolean;
	resetTaskEditorState: () => void;
	setIsClearTrashDialogOpen: Dispatch<SetStateAction<boolean>>;
	resetGitActionState: () => void;
	resetProjectNavigationState: () => void;
	resetTerminalPanelsState: () => void;
	resetWorkspaceSyncState: (targetProjectId?: string | null) => void;
}

/**
 * Consolidates the scattered effects that reset various UI state when the
 * active project changes or a project switch is in progress.
 */
export function useProjectSwitchCleanup({
	currentProjectId,
	navigationCurrentProjectId,
	isProjectSwitching,
	resetTaskEditorState,
	setIsClearTrashDialogOpen,
	resetGitActionState,
	resetProjectNavigationState,
	resetTerminalPanelsState,
	resetWorkspaceSyncState,
}: UseProjectSwitchCleanupInput): void {
	// Dispose persistent terminal instances for the previous project.
	// These hold xterm instances, WebGL contexts, and WebSocket connections that
	// are no longer reachable once the project changes.
	const previousProjectIdRef = useRef(currentProjectId);
	useEffect(() => {
		const previousProjectId = previousProjectIdRef.current;
		previousProjectIdRef.current = currentProjectId;
		if (previousProjectId && previousProjectId !== currentProjectId) {
			releaseAll();
			disposeAllDedicatedTerminalsForWorkspace(previousProjectId);
		}
	}, [currentProjectId]);

	// Reset workspace metadata store when switching projects.
	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceMetadataStore();
	}, [isProjectSwitching]);

	// Reset workspace sync state when switching projects — pass the target project
	// so the board cache can restore its data immediately (stale-while-revalidate).
	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceSyncState(navigationCurrentProjectId);
	}, [isProjectSwitching, navigationCurrentProjectId, resetWorkspaceSyncState]);

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
