import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import { createContext, useContext, useMemo } from "react";
import { useDocumentVisibility } from "@/hooks/notifications";
import { type UseProjectNavigationResult, useProjectNavigation, useProjectSync } from "@/hooks/project";
import { ProjectRuntimeProvider } from "@/providers/project-runtime-provider";
import type { RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardData } from "@/types";

// ---------------------------------------------------------------------------
// Context value — project-level state: navigation, runtime stream/project sync,
// project selection, and persistence/hydration state.
//
// The value is constructed inside ProjectProvider, which owns all project-level
// hooks. Child components read project state via useProjectContext().
// ---------------------------------------------------------------------------

export interface ProjectContextValue {
	// --- useProjectNavigation ---
	currentProjectId: UseProjectNavigationResult["currentProjectId"];
	projects: UseProjectNavigationResult["projects"];
	streamedProjectState: UseProjectNavigationResult["projectState"];
	projectMetadata: UseProjectNavigationResult["projectMetadata"];
	notificationSessions: UseProjectNavigationResult["notificationSessions"];
	notificationProjectIds: UseProjectNavigationResult["notificationProjectIds"];
	latestTaskReadyForReview: UseProjectNavigationResult["latestTaskReadyForReview"];
	latestTaskTitleUpdate: UseProjectNavigationResult["latestTaskTitleUpdate"];
	latestTaskBaseRefUpdate: UseProjectNavigationResult["latestTaskBaseRefUpdate"];
	latestTaskWorkingDirectoryUpdate: UseProjectNavigationResult["latestTaskWorkingDirectoryUpdate"];
	logLevel: UseProjectNavigationResult["logLevel"];
	debugLogEntries: UseProjectNavigationResult["debugLogEntries"];
	streamError: UseProjectNavigationResult["streamError"];
	isRuntimeDisconnected: UseProjectNavigationResult["isRuntimeDisconnected"];
	hasReceivedSnapshot: UseProjectNavigationResult["hasReceivedSnapshot"];
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

	// --- useProjectSync (subset exposed via context) ---
	projectPath: string | null;
	projectGit: RuntimeGitRepositoryInfo | null;
	refreshProjectState: () => Promise<void>;

	// --- useProjectSync (additional outputs needed by AppContent) ---
	projectRevision: number | null;
	setProjectRevision: Dispatch<SetStateAction<number | null>>;
	projectHydrationNonce: number;
	shouldSkipPersistOnHydration: boolean;
	isProjectStateRefreshing: boolean;
	isProjectMetadataPending: boolean;
	resetProjectSyncState: (targetProjectId?: string | null) => void;

	// --- Document visibility ---
	isDocumentVisible: boolean;

	// --- Board-level state bridged through for downstream consumers ---
	canPersistProjectState: boolean;
	isServedFromBoardCache: boolean;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjectContext(): ProjectContextValue {
	const ctx = useContext(ProjectContext);
	if (!ctx) {
		throw new Error("useProjectContext must be used within a ProjectContext.Provider");
	}
	return ctx;
}

// ---------------------------------------------------------------------------
// Provider component — calls all project-level hooks and exposes the combined
// value via ProjectContext. This is the foundation layer: it reads from nothing
// (no parent contexts), and all other providers depend on it.
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
	// --- Core project navigation ---
	const {
		currentProjectId,
		projects,
		projectState: streamedProjectState,
		projectMetadata,
		notificationSessions,
		notificationProjectIds,
		latestTaskReadyForReview,
		latestTaskTitleUpdate,
		latestTaskBaseRefUpdate,
		latestTaskWorkingDirectoryUpdate,
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

	// --- Document visibility ---
	const isDocumentVisible = useDocumentVisibility();

	// --- Project sync ---
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

	// --- Context value ---
	const value = useMemo<ProjectContextValue>(
		() => ({
			currentProjectId,
			projects,
			streamedProjectState,
			projectMetadata,
			notificationSessions,
			notificationProjectIds,
			latestTaskReadyForReview,
			latestTaskTitleUpdate,
			latestTaskBaseRefUpdate,
			latestTaskWorkingDirectoryUpdate,
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
			currentProjectId,
			projects,
			streamedProjectState,
			projectMetadata,
			notificationSessions,
			notificationProjectIds,
			latestTaskReadyForReview,
			latestTaskTitleUpdate,
			latestTaskBaseRefUpdate,
			latestTaskWorkingDirectoryUpdate,
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
		<ProjectContext.Provider value={value}>
			<ProjectRuntimeProvider
				currentProjectId={currentProjectId}
				navigationCurrentProjectId={navigationCurrentProjectId}
			>
				{children}
			</ProjectRuntimeProvider>
		</ProjectContext.Provider>
	);
}
