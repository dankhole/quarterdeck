import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import { createContext, useContext, useEffect, useMemo } from "react";
import { updateBrowserSnapshotContext } from "@/diagnostics";
import { useDocumentVisibility } from "@/hooks/notifications";
import { buildProjectNotificationProjection } from "@/hooks/notifications/project-notifications";
import { type UseProjectNavigationResult, useProjectNavigation, useProjectSync } from "@/hooks/project";
import { ProjectRuntimeProvider } from "@/providers/project-runtime-provider";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import type { RuntimeGitRepositoryInfo, RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardData } from "@/types";

// ---------------------------------------------------------------------------
// Context values - project-level ownership seams.
//
// ProjectProvider remains the composition point for project-level hooks, but it
// exposes narrow contracts so consumers do not regather project navigation,
// runtime stream ingress, persistence gates, and notification projection behind
// one broad context bag.
// ---------------------------------------------------------------------------

export interface ProjectNavigationContextValue {
	currentProjectId: UseProjectNavigationResult["currentProjectId"];
	projects: UseProjectNavigationResult["projects"];
	navigationCurrentProjectId: UseProjectNavigationResult["navigationCurrentProjectId"];
	removingProjectId: UseProjectNavigationResult["removingProjectId"];
	hasNoProjects: UseProjectNavigationResult["hasNoProjects"];
	isProjectSwitching: UseProjectNavigationResult["isProjectSwitching"];
	handleSelectProject: UseProjectNavigationResult["handleSelectProject"];
	handlePreloadProject: UseProjectNavigationResult["handlePreloadProject"];
	handleAddProject: UseProjectNavigationResult["handleAddProject"];
	handleConfirmManualProjectPath: UseProjectNavigationResult["handleConfirmManualProjectPath"];
	handleCancelManualProjectPath: UseProjectNavigationResult["handleCancelManualProjectPath"];
	handleConfirmInitializeGitProject: UseProjectNavigationResult["handleConfirmInitializeGitProject"];
	handleCancelInitializeGitProject: UseProjectNavigationResult["handleCancelInitializeGitProject"];
	handleRemoveProject: UseProjectNavigationResult["handleRemoveProject"];
	handleReorderProjects: UseProjectNavigationResult["handleReorderProjects"];
	pendingGitInitializationPath: UseProjectNavigationResult["pendingGitInitializationPath"];
	isInitializingGitProject: UseProjectNavigationResult["isInitializingGitProject"];
	isManualProjectPathDialogOpen: UseProjectNavigationResult["isManualProjectPathDialogOpen"];
	isAddingManualProject: UseProjectNavigationResult["isAddingManualProject"];
	resetProjectNavigationState: UseProjectNavigationResult["resetProjectNavigationState"];
}

export interface ProjectRuntimeStreamContextValue {
	streamedProjectState: UseProjectNavigationResult["projectState"];
	projectMetadata: UseProjectNavigationResult["projectMetadata"];
	latestTaskReadyForReview: UseProjectNavigationResult["latestTaskReadyForReview"];
	latestTaskTitleUpdate: UseProjectNavigationResult["latestTaskTitleUpdate"];
	latestTaskBaseRefUpdate: UseProjectNavigationResult["latestTaskBaseRefUpdate"];
	streamError: UseProjectNavigationResult["streamError"];
	isRuntimeDisconnected: UseProjectNavigationResult["isRuntimeDisconnected"];
	hasReceivedSnapshot: UseProjectNavigationResult["hasReceivedSnapshot"];
}

export interface ProjectNotificationContextValue {
	notificationProjects: RuntimeProjectNotificationStateMap;
	needsInputByProject: Record<string, number>;
	currentProjectHasNeedsInput: boolean;
	otherProjectsHaveNeedsInput: boolean;
}

export interface ProjectSyncContextValue {
	boardProjectId: string | null;
	projectPath: string | null;
	projectGit: RuntimeGitRepositoryInfo | null;
	refreshProjectState: () => Promise<void>;
	isProjectMetadataPending: boolean;
	resetProjectSyncState: (targetProjectId?: string | null) => void;
	isDocumentVisible: boolean;
	isServedFromBoardCache: boolean;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	presentLifecycleBoard: Dispatch<SetStateAction<BoardData>>;
	flushBoardCommands: () => Promise<{ ok: boolean; message?: string }>;
	getAuthoritativeRevision: () => number | null;
	applyLifecycleProjectState: (state: RuntimeProjectStateResponse) => void;
}

export const ProjectNavigationContext = createContext<ProjectNavigationContextValue | null>(null);
export const ProjectRuntimeStreamContext = createContext<ProjectRuntimeStreamContextValue | null>(null);
export const ProjectNotificationContext = createContext<ProjectNotificationContextValue | null>(null);
export const ProjectSyncContext = createContext<ProjectSyncContextValue | null>(null);

export function useProjectNavigationContext(): ProjectNavigationContextValue {
	const ctx = useContext(ProjectNavigationContext);
	if (!ctx) {
		throw new Error("useProjectNavigationContext must be used within a ProjectNavigationContext.Provider");
	}
	return ctx;
}

export function useProjectRuntimeStreamContext(): ProjectRuntimeStreamContextValue {
	const ctx = useContext(ProjectRuntimeStreamContext);
	if (!ctx) {
		throw new Error("useProjectRuntimeStreamContext must be used within a ProjectRuntimeStreamContext.Provider");
	}
	return ctx;
}

export function useProjectNotificationContext(): ProjectNotificationContextValue {
	const ctx = useContext(ProjectNotificationContext);
	if (!ctx) {
		throw new Error("useProjectNotificationContext must be used within a ProjectNotificationContext.Provider");
	}
	return ctx;
}

export function useProjectSyncContext(): ProjectSyncContextValue {
	const ctx = useContext(ProjectSyncContext);
	if (!ctx) {
		throw new Error("useProjectSyncContext must be used within a ProjectSyncContext.Provider");
	}
	return ctx;
}

// ---------------------------------------------------------------------------
// Provider component - calls all project-level hooks and exposes them through
// explicit project seams. This is the foundation layer: it reads from nothing
// (no parent contexts), and other providers depend on the slice they need.
//
// Props bridge values that are owned above the provider tree:
// - onProjectSwitchStart: cleanup callback defined in App
// - projectBoardSessionsRef/setProjectBoardSessions: app-shell-owned optimistic
//   state seam used by the runtime-authoritative command synchronizer
// ---------------------------------------------------------------------------

export interface ProjectProviderProps {
	onProjectSwitchStart: () => void;
	projectBoardSessionsRef: MutableRefObject<{
		board: BoardData;
		sessions: Record<string, RuntimeTaskSessionSummary>;
	}>;
	setProjectBoardSessions: Dispatch<
		SetStateAction<{
			board: BoardData;
			sessions: Record<string, RuntimeTaskSessionSummary>;
		}>
	>;
	children: ReactNode;
}

export function ProjectProvider({
	onProjectSwitchStart,
	projectBoardSessionsRef,
	setProjectBoardSessions,
	children,
}: ProjectProviderProps): ReactNode {
	const {
		currentProjectId,
		projects,
		projectState: streamedProjectState,
		projectMetadata,
		notificationProjects,
		latestTaskReadyForReview,
		latestTaskTitleUpdate,
		latestTaskBaseRefUpdate,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
		navigationCurrentProjectId,
		removingProjectId,
		hasNoProjects,
		isProjectSwitching,
		handleSelectProject,
		handlePreloadProject,
		handleAddProject,
		handleConfirmManualProjectPath,
		handleCancelManualProjectPath,
		handleConfirmInitializeGitProject,
		handleCancelInitializeGitProject,
		handleRemoveProject,
		handleReorderProjects,
		pendingGitInitializationPath,
		isInitializingGitProject,
		isManualProjectPathDialogOpen,
		isAddingManualProject,
		resetProjectNavigationState,
	} = useProjectNavigation({
		onProjectSwitchStart,
	});

	const notificationProjection = useMemo(
		() => buildProjectNotificationProjection(notificationProjects, currentProjectId),
		[currentProjectId, notificationProjects],
	);

	const isDocumentVisible = useDocumentVisibility();

	const {
		boardProjectId,
		projectPath,
		projectGit,
		isProjectMetadataPending,
		isServedFromBoardCache,
		refreshProjectState,
		resetProjectSyncState,
		setBoard,
		presentLifecycleBoard,
		flushBoardCommands,
		getAuthoritativeRevision,
		applyLifecycleProjectState,
	} = useProjectSync({
		currentProjectId,
		streamedProjectState,
		hasNoProjects,
		hasReceivedSnapshot,
		isDocumentVisible,
		projectBoardSessionsRef,
		setProjectBoardSessions,
	});
	const projectRevision = getAuthoritativeRevision();

	useEffect(() => {
		updateBrowserSnapshotContext({
			activeProjectId: currentProjectId,
			boardRevision: projectRevision,
		});
	}, [currentProjectId, projectRevision]);

	const navigationValue = useMemo<ProjectNavigationContextValue>(
		() => ({
			currentProjectId,
			projects,
			navigationCurrentProjectId,
			removingProjectId,
			hasNoProjects,
			isProjectSwitching,
			handleSelectProject,
			handlePreloadProject,
			handleAddProject,
			handleConfirmManualProjectPath,
			handleCancelManualProjectPath,
			handleConfirmInitializeGitProject,
			handleCancelInitializeGitProject,
			handleRemoveProject,
			handleReorderProjects,
			pendingGitInitializationPath,
			isInitializingGitProject,
			isManualProjectPathDialogOpen,
			isAddingManualProject,
			resetProjectNavigationState,
		}),
		[
			currentProjectId,
			projects,
			navigationCurrentProjectId,
			removingProjectId,
			hasNoProjects,
			isProjectSwitching,
			handleSelectProject,
			handlePreloadProject,
			handleAddProject,
			handleConfirmManualProjectPath,
			handleCancelManualProjectPath,
			handleConfirmInitializeGitProject,
			handleCancelInitializeGitProject,
			handleRemoveProject,
			handleReorderProjects,
			pendingGitInitializationPath,
			isInitializingGitProject,
			isManualProjectPathDialogOpen,
			isAddingManualProject,
			resetProjectNavigationState,
		],
	);

	const streamValue = useMemo<ProjectRuntimeStreamContextValue>(
		() => ({
			streamedProjectState,
			projectMetadata,
			latestTaskReadyForReview,
			latestTaskTitleUpdate,
			latestTaskBaseRefUpdate,
			streamError,
			isRuntimeDisconnected,
			hasReceivedSnapshot,
		}),
		[
			streamedProjectState,
			projectMetadata,
			latestTaskReadyForReview,
			latestTaskTitleUpdate,
			latestTaskBaseRefUpdate,
			streamError,
			isRuntimeDisconnected,
			hasReceivedSnapshot,
		],
	);

	const notificationValue = useMemo<ProjectNotificationContextValue>(
		() => ({
			notificationProjects,
			needsInputByProject: notificationProjection.needsInputByProject,
			currentProjectHasNeedsInput: notificationProjection.currentProjectHasNeedsInput,
			otherProjectsHaveNeedsInput: notificationProjection.otherProjectsHaveNeedsInput,
		}),
		[notificationProjects, notificationProjection],
	);

	const syncValue = useMemo<ProjectSyncContextValue>(
		() => ({
			boardProjectId,
			projectPath,
			projectGit,
			refreshProjectState,
			isProjectMetadataPending,
			resetProjectSyncState,
			isDocumentVisible,
			isServedFromBoardCache,
			setBoard,
			presentLifecycleBoard,
			flushBoardCommands,
			getAuthoritativeRevision,
			applyLifecycleProjectState,
		}),
		[
			boardProjectId,
			projectPath,
			projectGit,
			refreshProjectState,
			isProjectMetadataPending,
			resetProjectSyncState,
			isDocumentVisible,
			isServedFromBoardCache,
			setBoard,
			presentLifecycleBoard,
			flushBoardCommands,
			getAuthoritativeRevision,
			applyLifecycleProjectState,
		],
	);

	return (
		<ProjectNavigationContext.Provider value={navigationValue}>
			<ProjectRuntimeStreamContext.Provider value={streamValue}>
				<ProjectNotificationContext.Provider value={notificationValue}>
					<ProjectSyncContext.Provider value={syncValue}>
						<ProjectRuntimeProvider
							currentProjectId={currentProjectId}
							navigationCurrentProjectId={navigationCurrentProjectId}
						>
							{children}
						</ProjectRuntimeProvider>
					</ProjectSyncContext.Provider>
				</ProjectNotificationContext.Provider>
			</ProjectRuntimeStreamContext.Provider>
		</ProjectNavigationContext.Provider>
	);
}
