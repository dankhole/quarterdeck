import { useEffect, useLayoutEffect, useRef } from "react";
import { setProjectMetadataScope } from "@/stores/project-metadata-store";
import { disposeAllDedicatedTerminalsForProject, releaseAll } from "@/terminal/terminal-pool";

interface UseProjectSwitchCleanupInput {
	currentProjectId: string | null;
	projectPath: string | null;
	isProjectUnavailable?: boolean;
	navigationCurrentProjectId: string | null;
	isProjectSwitching: boolean;
	resetTaskEditorWorkflow: () => void;
	setIsClearTrashDialogOpen: (open: boolean) => void;
	resetGitActionState: () => void;
	resetProjectNavigationState: () => void;
	resetTerminalPanelsState: () => void;
	resetProjectSyncState: (targetProjectId?: string | null) => void;
}

/**
 * Consolidates the scattered effects that reset various UI state when the
 * active project changes or a project switch is in progress.
 */
export function useProjectSwitchCleanup({
	currentProjectId,
	projectPath,
	isProjectUnavailable = false,
	navigationCurrentProjectId,
	isProjectSwitching,
	resetTaskEditorWorkflow,
	setIsClearTrashDialogOpen,
	resetGitActionState,
	resetProjectNavigationState,
	resetTerminalPanelsState,
	resetProjectSyncState,
}: UseProjectSwitchCleanupInput): void {
	// Dispose persistent terminal instances for the previous project.
	// These hold xterm instances, WebGL contexts, and WebSocket connections that
	// are no longer reachable once the project changes.
	const previousProjectRef = useRef({
		projectId: currentProjectId,
		path: projectPath,
		unavailable: isProjectUnavailable,
	});
	useEffect(() => {
		const previous = previousProjectRef.current;
		previousProjectRef.current = {
			projectId: currentProjectId,
			path: projectPath,
			unavailable: isProjectUnavailable,
		};
		const locationChanged = previous.path !== null && previous.path !== projectPath;
		if (
			previous.projectId &&
			(previous.projectId !== currentProjectId || locationChanged || (!previous.unavailable && isProjectUnavailable))
		) {
			releaseAll();
			disposeAllDedicatedTerminalsForProject(previous.projectId);
		}
	}, [currentProjectId, projectPath, isProjectUnavailable]);

	// Scope the shared Git/task metadata read model to the navigation target
	// before paint. Late async results for the previous project are rejected by
	// the store instead of being attached to same-shaped task UI in the target.
	useLayoutEffect(() => {
		setProjectMetadataScope(navigationCurrentProjectId);
	}, [navigationCurrentProjectId]);

	// Reset project sync state when switching projects — pass the target project
	// so the board cache can restore its data immediately (stale-while-revalidate).
	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetProjectSyncState(navigationCurrentProjectId);
	}, [isProjectSwitching, navigationCurrentProjectId, resetProjectSyncState]);

	// Reset task editor state when switching projects.
	const previousSwitchingRef = useRef({ active: false, target: navigationCurrentProjectId });
	useLayoutEffect(() => {
		const previous = previousSwitchingRef.current;
		previousSwitchingRef.current = { active: isProjectSwitching, target: navigationCurrentProjectId };
		if (isProjectSwitching && (!previous.active || previous.target !== navigationCurrentProjectId))
			resetTaskEditorWorkflow();
	}, [isProjectSwitching, navigationCurrentProjectId, resetTaskEditorWorkflow]);

	// Track transient ownership separately from the passive terminal cleanup.
	// Resolving the initial path for the same project is hydration, not a switch.
	const previousTransientScopeRef = useRef<{
		projectId: string | null;
		path: string | null;
		unavailable: boolean;
	} | null>(null);
	useLayoutEffect(() => {
		const previous = previousTransientScopeRef.current;
		previousTransientScopeRef.current = {
			projectId: currentProjectId,
			path: projectPath,
			unavailable: isProjectUnavailable,
		};
		if (
			previous &&
			previous.projectId === currentProjectId &&
			(previous.path === null || previous.path === projectPath) &&
			previous.unavailable === isProjectUnavailable
		)
			return;
		resetTaskEditorWorkflow();
		setIsClearTrashDialogOpen(false);
		resetGitActionState();
		resetProjectNavigationState();
		resetTerminalPanelsState();
	}, [
		currentProjectId,
		projectPath,
		isProjectUnavailable,
		resetGitActionState,
		resetProjectNavigationState,
		resetTaskEditorWorkflow,
		resetTerminalPanelsState,
		setIsClearTrashDialogOpen,
	]);
}
