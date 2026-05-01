import type { MutableRefObject } from "react";
import type { BoardContextValue } from "@/providers/board-provider";
import type { DialogContextValue } from "@/providers/dialog-provider";
import type { GitContextValue } from "@/providers/git-provider";
import type { InteractionsContextValue } from "@/providers/interactions-provider";
import type {
	ProjectNavigationContextValue,
	ProjectNotificationContextValue,
	ProjectRuntimeStreamContextValue,
	ProjectSyncContextValue,
} from "@/providers/project-provider";
import type { ProjectRuntimeContextValue } from "@/providers/project-runtime-provider";
import type { SurfaceNavigationContextValue } from "@/providers/surface-navigation-provider";
import type { TaskEditorContextValue } from "@/providers/task-editor-provider";
import type { TerminalContextValue } from "@/providers/terminal-provider";
import { useAppHotkeys } from "./use-app-hotkeys";
import { useAppProjectNotificationEffects } from "./use-app-project-notification-effects";
import { useAppProjectPersistenceEffects } from "./use-app-project-persistence-effects";
import { useAppProjectSyncEffects } from "./use-app-project-sync-effects";
import { useEscapeHandler } from "./use-escape-handler";

// App shell orchestration only. If another effect family needs to land here,
// prefer extracting a focused hook over widening this input surface further.
interface UseAppSideEffectsInput {
	projectNavigation: ProjectNavigationContextValue;
	projectStream: ProjectRuntimeStreamContextValue;
	projectSync: ProjectSyncContextValue;
	projectNotifications: ProjectNotificationContextValue;
	projectRuntime: ProjectRuntimeContextValue;
	board: BoardContextValue;
	taskEditor: TaskEditorContextValue;
	git: GitContextValue;
	navigation: SurfaceNavigationContextValue;
	terminal: TerminalContextValue;
	interactions: InteractionsContextValue;
	dialog: DialogContextValue;
	serverMutationInFlightRef: MutableRefObject<boolean>;
	handleToggleFileFinder: () => void;
	handleToggleTextSearch: () => void;
}

export function useAppSideEffects({
	projectNavigation,
	projectStream,
	projectSync,
	projectNotifications,
	projectRuntime,
	board,
	taskEditor,
	git,
	navigation,
	terminal,
	interactions,
	dialog,
	serverMutationInFlightRef,
	handleToggleFileFinder,
	handleToggleTextSearch,
}: UseAppSideEffectsInput): void {
	useAppProjectNotificationEffects({
		board: board.board,
		selectedTaskId: board.selectedTaskId,
		currentProjectId: projectNavigation.currentProjectId,
		navigationCurrentProjectId: projectNavigation.navigationCurrentProjectId,
		projectPath: projectSync.projectPath,
		latestTaskReadyForReview: projectStream.latestTaskReadyForReview,
		streamError: projectStream.streamError,
		isRuntimeDisconnected: projectStream.isRuntimeDisconnected,
		notificationProjects: projectNotifications.notificationProjects,
		audibleNotificationsEnabled: projectRuntime.audibleNotificationsEnabled,
		audibleNotificationVolume: projectRuntime.audibleNotificationVolume,
		audibleNotificationEvents: projectRuntime.audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden: projectRuntime.audibleNotificationsOnlyWhenHidden,
		audibleNotificationSuppressCurrentProject: projectRuntime.audibleNotificationSuppressCurrentProject,
	});

	useAppProjectSyncEffects({
		currentProjectId: projectNavigation.currentProjectId,
		navigationCurrentProjectId: projectNavigation.navigationCurrentProjectId,
		hasNoProjects: projectNavigation.hasNoProjects,
		isProjectSwitching: projectNavigation.isProjectSwitching,
		isDocumentVisible: projectSync.isDocumentVisible,
		projectMetadata: projectStream.projectMetadata,
		latestTaskTitleUpdate: projectStream.latestTaskTitleUpdate,
		latestTaskBaseRefUpdate: projectStream.latestTaskBaseRefUpdate,
		selectedCard: board.selectedCard,
		isHomeTerminalOpen: terminal.isHomeTerminalOpen,
		closeHomeTerminal: terminal.closeHomeTerminal,
		setBoard: board.setBoard,
		resetTaskEditorWorkflow: taskEditor.resetTaskEditorWorkflow,
		setIsClearTrashDialogOpen: dialog.setIsClearTrashDialogOpen,
		resetGitActionState: git.resetGitActionState,
		resetProjectNavigationState: projectNavigation.resetProjectNavigationState,
		resetTerminalPanelsState: terminal.resetTerminalPanelsState,
		resetProjectSyncState: projectSync.resetProjectSyncState,
	});

	useAppHotkeys({
		selectedCard: board.selectedCard,
		canUseCreateTaskShortcut: !projectNavigation.hasNoProjects && projectNavigation.currentProjectId !== null,
		currentProjectId: projectNavigation.currentProjectId,
		handleToggleDetailTerminal: terminal.handleToggleDetailTerminal,
		handleToggleHomeTerminal: terminal.handleToggleHomeTerminal,
		handleOpenCreateTask: taskEditor.taskEditor.handleOpenCreateTask,
		handleOpenSettings: dialog.handleOpenSettings,
		onStartAllTasks: interactions.handleStartAllBacklogTasksFromBoard,
		handleToggleDebugLogPanel: dialog.debugLogging.toggleDebugLogPanel,
		handleToggleFileFinder,
		handleToggleTextSearch,
	});

	useEscapeHandler({
		isGitHistoryOpen: navigation.isGitHistoryOpen,
		closeGitHistory: navigation.closeGitHistory,
		selectedCard: board.selectedCard,
		setSelectedTaskId: board.setSelectedTaskId,
	});

	useAppProjectPersistenceEffects({
		board: board.board,
		currentProjectId: projectNavigation.currentProjectId,
		projectRevision: projectSync.projectRevision,
		hydrationNonce: projectSync.projectHydrationNonce,
		shouldSkipPersistOnHydration: projectSync.shouldSkipPersistOnHydration,
		canPersistProjectState: projectSync.canPersistProjectState,
		isDocumentVisible: projectSync.isDocumentVisible,
		isProjectStateRefreshing: projectSync.isProjectStateRefreshing,
		refetchProjectState: projectSync.refreshProjectState,
		onProjectRevisionChange: projectSync.setProjectRevision,
		serverMutationInFlightRef,
	});
}
