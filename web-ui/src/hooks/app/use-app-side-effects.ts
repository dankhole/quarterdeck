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
import type { TerminalContextValue } from "@/providers/terminal-provider";
import { saveProjectState } from "@/runtime/project-state-query";
import { useProjectPersistence } from "@/runtime/use-project-persistence";
import { findCardSelection } from "@/state/board-state";
import { useAppHotkeys } from "./use-app-hotkeys";
import { useEscapeHandler } from "./use-escape-handler";

interface UseAppSideEffectsInput {
	project: ProjectContextValue;
	board: BoardContextValue;
	git: GitContextValue;
	terminal: TerminalContextValue;
	interactions: InteractionsContextValue;
	dialog: DialogContextValue;
	pendingTaskStartAfterEditId: string | null;
	clearPendingTaskStartAfterEditId: () => void;
	serverMutationInFlightRef: MutableRefObject<boolean>;
	handleToggleFileFinder: () => void;
	handleToggleTextSearch: () => void;
}

export function useAppSideEffects({
	project,
	board,
	git,
	terminal,
	interactions,
	dialog,
	pendingTaskStartAfterEditId,
	clearPendingTaskStartAfterEditId,
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
		audibleNotificationsEnabled: project.audibleNotificationsEnabled,
		audibleNotificationVolume: project.audibleNotificationVolume,
		audibleNotificationEvents: project.audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden: project.audibleNotificationsOnlyWhenHidden,
		audibleNotificationSuppressCurrentProject: project.audibleNotificationSuppressCurrentProject,
		notificationWorkspaceIds: project.notificationWorkspaceIds,
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
		resetTaskEditorState: board.taskEditor.resetTaskEditorState,
		setIsClearTrashDialogOpen: dialog.setIsClearTrashDialogOpen as Dispatch<SetStateAction<boolean>>,
		resetGitActionState: git.resetGitActionState,
		resetProjectNavigationState: project.resetProjectNavigationState,
		resetTerminalPanelsState: terminal.resetTerminalPanelsState,
		resetWorkspaceSyncState: project.resetWorkspaceSyncState,
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
		handleToggleGitHistory: git.handleToggleGitHistory,
		onStartAllTasks: interactions.handleStartAllBacklogTasksFromBoard,
		handleToggleDebugLogPanel: dialog.debugLogging.toggleDebugLogPanel,
		handleToggleFileFinder,
		handleToggleTextSearch,
	});

	useEscapeHandler({
		isGitHistoryOpen: git.isGitHistoryOpen,
		setIsGitHistoryOpen: git.setIsGitHistoryOpen,
		selectedCard: board.selectedCard,
		setSelectedTaskId: board.setSelectedTaskId,
	});

	const persistWorkspaceStateAsync = useCallback(
		async (input: { projectId: string; payload: Parameters<typeof saveProjectState>[1] }) =>
			await saveProjectState(input.projectId, input.payload),
		[],
	);

	const handleWorkspaceStateConflict = useCallback(() => {
		if (serverMutationInFlightRef.current) return;
		showAppToast(
			{
				intent: "warning",
				icon: "warning-sign",
				message:
					"Workspace changed elsewhere (e.g. another tab). Synced latest state. Retry your last edit if needed.",
				timeout: 5000,
			},
			"project-state-conflict",
		);
	}, [serverMutationInFlightRef]);

	useProjectPersistence({
		board: board.board,
		sessions: board.sessions,
		currentProjectId: project.currentProjectId,
		projectRevision: project.projectRevision,
		hydrationNonce: project.projectHydrationNonce,
		canPersistProjectState: project.canPersistProjectState,
		isDocumentVisible: project.isDocumentVisible,
		isProjectStateRefreshing: project.isProjectStateRefreshing,
		persistWorkspaceState: persistWorkspaceStateAsync,
		refetchWorkspaceState: project.refreshWorkspaceState,
		onWorkspaceRevisionChange: project.setWorkspaceRevision,
		onWorkspaceStateConflict: handleWorkspaceStateConflict,
	});

	useEffect(() => {
		if (!pendingTaskStartAfterEditId) return;
		const selection = findCardSelection(board.board, pendingTaskStartAfterEditId);
		if (!selection || selection.column.id !== "backlog") return;
		interactions.handleStartTaskFromBoard(pendingTaskStartAfterEditId);
		clearPendingTaskStartAfterEditId();
	}, [
		board.board,
		clearPendingTaskStartAfterEditId,
		interactions.handleStartTaskFromBoard,
		pendingTaskStartAfterEditId,
	]);
}
