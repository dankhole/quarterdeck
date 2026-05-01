import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import { createContext, useContext, useMemo } from "react";
import { useDocumentVisibility } from "@/hooks/notifications";
import { buildProjectNotificationProjection } from "@/hooks/notifications/project-notifications";
import { type UseProjectNavigationResult, useProjectNavigation, useProjectSync } from "@/hooks/project";
import { ProjectRuntimeProvider } from "@/providers/project-runtime-provider";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import type { RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";
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
	handleConfirmInitializeGitProject: UseProjectNavigationResult["handleConfirmInitializeGitProject"];
	handleCancelInitializeGitProject: UseProjectNavigationResult["handleCancelInitializeGitProject"];
	handleRemoveProject: UseProjectNavigationResult["handleRemoveProject"];
	handleReorderProjects: UseProjectNavigationResult["handleReorderProjects"];
	pendingGitInitializationPath: UseProjectNavigationResult["pendingGitInitializationPath"];
	isInitializingGitProject: UseProjectNavigationResult["isInitializingGitProject"];
	resetProjectNavigationState: UseProjectNavigationResult["resetProjectNavigationState"];
}

export interface ProjectRuntimeStreamContextValue {
	streamedProjectState: UseProjectNavigationResult["projectState"];
	projectMetadata: UseProjectNavigationResult["projectMetadata"];
	latestTaskReadyForReview: UseProjectNavigationResult["latestTaskReadyForReview"];
	latestTaskTitleUpdate: UseProjectNavigationResult["latestTaskTitleUpdate"];
	latestTaskBaseRefUpdate: UseProjectNavigationResult["latestTaskBaseRefUpdate"];
	logLevel: UseProjectNavigationResult["logLevel"];
	debugLogEntries: UseProjectNavigationResult["debugLogEntries"];
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
	projectPath: string | null;
	projectGit: RuntimeGitRepositoryInfo | null;
	refreshProjectState: () => Promise<void>;
	projectRevision: number | null;
	setProjectRevision: Dispatch<SetStateAction<number | null>>;
	projectHydrationNonce: number;
	shouldSkipPersistOnHydration: boolean;
	isProjectStateRefreshing: boolean;
	isProjectMetadataPending: boolean;
	resetProjectSyncState: (targetProjectId?: string | null) => void;
	isDocumentVisible: boolean;
	canPersistProjectState: boolean;
	isServedFromBoardCache: boolean;
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
// - projectBoardSessionsRef/setProjectBoardSessions/setCanPersistProjectState:
//   app-shell-owned state seam needed by useProjectSync
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
	canPersistProjectState: boolean;
	setCanPersistProjectState: Dispatch<SetStateAction<boolean>>;
	children: ReactNode;
}

export function ProjectProvider({
	onProjectSwitchStart,
	projectBoardSessionsRef,
	setProjectBoardSessions,
	canPersistProjectState,
	setCanPersistProjectState,
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
		logLevel,
		debugLogEntries,
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
		handleConfirmInitializeGitProject,
		handleCancelInitializeGitProject,
		handleRemoveProject,
		handleReorderProjects,
		pendingGitInitializationPath,
		isInitializingGitProject,
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
		projectPath,
		projectGit,
		projectRevision,
		setProjectRevision,
		projectHydrationNonce,
		shouldSkipPersistOnHydration,
		isProjectStateRefreshing,
		isProjectMetadataPending,
		isServedFromBoardCache,
		refreshProjectState,
		resetProjectSyncState,
	} = useProjectSync({
		currentProjectId,
		streamedProjectState,
		hasNoProjects,
		hasReceivedSnapshot,
		isDocumentVisible,
		projectBoardSessionsRef,
		setProjectBoardSessions,
		setCanPersistProjectState,
	});

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
			handleConfirmInitializeGitProject,
			handleCancelInitializeGitProject,
			handleRemoveProject,
			handleReorderProjects,
			pendingGitInitializationPath,
			isInitializingGitProject,
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
			handleConfirmInitializeGitProject,
			handleCancelInitializeGitProject,
			handleRemoveProject,
			handleReorderProjects,
			pendingGitInitializationPath,
			isInitializingGitProject,
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
			logLevel,
			debugLogEntries,
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
			logLevel,
			debugLogEntries,
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
			projectPath,
			projectGit,
			refreshProjectState,
			projectRevision,
			setProjectRevision,
			projectHydrationNonce,
			shouldSkipPersistOnHydration,
			isProjectStateRefreshing,
			isProjectMetadataPending,
			resetProjectSyncState,
			isDocumentVisible,
			canPersistProjectState,
			isServedFromBoardCache,
		}),
		[
			projectPath,
			projectGit,
			refreshProjectState,
			projectRevision,
			setProjectRevision,
			projectHydrationNonce,
			shouldSkipPersistOnHydration,
			isProjectStateRefreshing,
			isProjectMetadataPending,
			resetProjectSyncState,
			isDocumentVisible,
			canPersistProjectState,
			isServedFromBoardCache,
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
