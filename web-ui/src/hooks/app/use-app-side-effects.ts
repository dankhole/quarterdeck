import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo } from "react";
import { showAppToast } from "@/components/app-toaster";
import { useBoardMetadataSync, useTaskBaseRefSync, useTaskTitleSync, useTaskWorkingDirectorySync } from "@/hooks/board";
import {
	useAudibleNotifications,
	useFocusedTaskNotification,
	useReviewReadyNotifications,
	useStreamErrorHandler,
} from "@/hooks/notifications";
import { useProjectSwitchCleanup } from "@/hooks/project";
import type { BoardContextValue } from "@/providers/board-provider";
import type { DialogContextValue } from "@/providers/dialog-provider";
import type { GitContextValue } from "@/providers/git-provider";
import type { InteractionsContextValue } from "@/providers/interactions-provider";
import type { ProjectContextValue } from "@/providers/project-provider";
import type { ProjectRuntimeContextValue } from "@/providers/project-runtime-provider";
import type { SurfaceNavigationContextValue } from "@/providers/surface-navigation-provider";
import type { TerminalContextValue } from "@/providers/terminal-provider";
import { saveProjectState } from "@/runtime/project-state-query";
import { useProjectPersistence } from "@/runtime/use-project-persistence";
import { useAppHotkeys } from "./use-app-hotkeys";
import { useEscapeHandler } from "./use-escape-handler";

interface UseAppSideEffectsInput {
	project: ProjectContextValue;
	projectRuntime: ProjectRuntimeContextValue;
	board: BoardContextValue;
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
	project,
	projectRuntime,
	board,
	git,
	navigation,
	terminal,
	interactions,
	dialog,
	serverMutationInFlightRef,
	handleToggleFileFinder,
	handleToggleTextSearch,
}: UseAppSideEffectsInput): void {
	useFocusedTaskNotification({ currentProjectId: project.currentProjectId, selectedTaskId: board.selectedTaskId });
	useBoardMetadataSync({ projectMetadata: project.projectMetadata, setBoard: board.setBoard });
	useReviewReadyNotifications({
		activeProjectId: project.navigationCurrentProjectId,
		latestTaskReadyForReview: project.latestTaskReadyForReview,
		projectPath: project.projectPath,
	});

	const trashTaskIdSet = useMemo(() => {
		const trashColumn = board.board.columns.find((column) => column.id === "trash");
		return trashColumn ? new Set(trashColumn.cards.map((card) => card.id)) : new Set<string>();
	}, [board.board.columns]);

	useAudibleNotifications({
		notificationSessions: project.notificationSessions,
		audibleNotificationsEnabled: projectRuntime.audibleNotificationsEnabled,
		audibleNotificationVolume: projectRuntime.audibleNotificationVolume,
		audibleNotificationEvents: projectRuntime.audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden: projectRuntime.audibleNotificationsOnlyWhenHidden,
		audibleNotificationSuppressCurrentProject: projectRuntime.audibleNotificationSuppressCurrentProject,
		notificationProjectIds: project.notificationProjectIds,
		currentProjectId: project.currentProjectId,
		suppressedTaskIds: trashTaskIdSet,
	});

	useTaskTitleSync({ latestTaskTitleUpdate: project.latestTaskTitleUpdate, setBoard: board.setBoard });
	useTaskBaseRefSync({ latestTaskBaseRefUpdate: project.latestTaskBaseRefUpdate, setBoard: board.setBoard });
	useTaskWorkingDirectorySync({
		latestTaskWorkingDirectoryUpdate: project.latestTaskWorkingDirectoryUpdate,
		setBoard: board.setBoard,
	});
	useStreamErrorHandler({ streamError: project.streamError, isRuntimeDisconnected: project.isRuntimeDisconnected });

	useProjectSwitchCleanup({
		currentProjectId: project.currentProjectId,
		navigationCurrentProjectId: project.navigationCurrentProjectId,
		isProjectSwitching: project.isProjectSwitching,
		resetBoardUiState: board.resetBoardUiState,
		setIsClearTrashDialogOpen: dialog.setIsClearTrashDialogOpen as Dispatch<SetStateAction<boolean>>,
		resetGitActionState: git.resetGitActionState,
		resetProjectNavigationState: project.resetProjectNavigationState,
		resetTerminalPanelsState: terminal.resetTerminalPanelsState,
		resetProjectSyncState: project.resetProjectSyncState,
	});

	useEffect(() => {
		if (board.selectedCard) return;
		if (project.hasNoProjects || !project.currentProjectId) {
			if (terminal.isHomeTerminalOpen) terminal.closeHomeTerminal();
		}
	}, [
		board.selectedCard,
		project.currentProjectId,
		project.hasNoProjects,
		terminal.closeHomeTerminal,
		terminal.isHomeTerminalOpen,
	]);

	useAppHotkeys({
		selectedCard: board.selectedCard,
		isDetailTerminalOpen: terminal.isDetailTerminalOpen,
		isHomeTerminalOpen: terminal.showHomeBottomTerminal,
		canUseCreateTaskShortcut: !project.hasNoProjects && project.currentProjectId !== null,
		currentProjectId: project.currentProjectId,
		handleToggleDetailTerminal: terminal.handleToggleDetailTerminal,
		handleToggleHomeTerminal: terminal.handleToggleHomeTerminal,
		handleToggleExpandDetailTerminal: terminal.handleToggleExpandDetailTerminal,
		handleToggleExpandHomeTerminal: terminal.handleToggleExpandHomeTerminal,
		handleOpenCreateTask: board.taskEditor.handleOpenCreateTask,
		handleOpenSettings: dialog.handleOpenSettings,
		handleToggleGitHistory: navigation.handleToggleGitHistory,
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

	const persistProjectStateAsync = useCallback(
		async (input: { projectId: string; payload: Parameters<typeof saveProjectState>[1] }) =>
			await saveProjectState(input.projectId, input.payload),
		[],
	);

	const handleProjectStateConflict = useCallback(() => {
		if (serverMutationInFlightRef.current) return;
		showAppToast(
			{
				intent: "warning",
				icon: "warning-sign",
				message:
					"Project changed elsewhere (e.g. another tab). Synced latest state. Retry your last edit if needed.",
				timeout: 5000,
			},
			"project-state-conflict",
		);
	}, [serverMutationInFlightRef]);

	useProjectPersistence({
		board: board.board,
		currentProjectId: project.currentProjectId,
		projectRevision: project.projectRevision,
		hydrationNonce: project.projectHydrationNonce,
		shouldSkipPersistOnHydration: project.shouldSkipPersistOnHydration,
		canPersistProjectState: project.canPersistProjectState,
		isDocumentVisible: project.isDocumentVisible,
		isProjectStateRefreshing: project.isProjectStateRefreshing,
		persistProjectState: persistProjectStateAsync,
		refetchProjectState: project.refreshProjectState,
		onProjectRevisionChange: project.setProjectRevision,
		onProjectStateConflict: handleProjectStateConflict,
	});
}
