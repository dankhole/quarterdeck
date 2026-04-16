// Main React composition root for the browser app.
// Keep this file focused on wiring top-level hooks and surfaces together, and
// push runtime-specific orchestration down into hooks and service modules.

import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { ArrowDown, ArrowUp, CircleArrowDown, FolderOpen } from "lucide-react";
import type { Dispatch, ReactElement, MouseEvent as ReactMouseEvent, ReactNode, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { CardDetailView } from "@/components/card-detail-view";
import { ClearTrashDialog } from "@/components/clear-trash-dialog";
import { ConflictBanner } from "@/components/conflict-banner";
import { DebugShelf } from "@/components/debug-shelf";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { BranchPillTrigger, BranchSelectorPopover } from "@/components/detail-panels/branch-selector-popover";
import { CheckoutConfirmationDialog } from "@/components/detail-panels/checkout-confirmation-dialog";
import { CommitPanel } from "@/components/detail-panels/commit-panel";
import { CreateBranchDialog } from "@/components/detail-panels/create-branch-dialog";
import { DeleteBranchDialog } from "@/components/detail-panels/delete-branch-dialog";
import { DetailToolbar, TOOLBAR_WIDTH } from "@/components/detail-panels/detail-toolbar";
import { MergeBranchDialog } from "@/components/detail-panels/merge-branch-dialog";
import { ScopeBar } from "@/components/detail-panels/scope-bar";
import { FilesView } from "@/components/files-view";
import { GitActionErrorDialog } from "@/components/git-action-error-dialog";
import { GitHistoryView } from "@/components/git-history-view";
import { GitView } from "@/components/git-view";
import { HardDeleteTaskDialog } from "@/components/hard-delete-task-dialog";
import { MigrateWorkingDirectoryDialog } from "@/components/migrate-working-directory-dialog";
import { ProjectDialogs } from "@/components/project-dialogs";
import { ProjectNavigationPanel } from "@/components/project-navigation-panel";
import { PromptShortcutEditorDialog } from "@/components/prompt-shortcut-editor-dialog";
import { QuarterdeckBoard } from "@/components/quarterdeck-board";
import { RuntimeSettingsDialog } from "@/components/runtime-settings-dialog";
import { TaskCreateDialog } from "@/components/task-create-dialog";
import { TaskInlineCreateCard } from "@/components/task-inline-create-card";
import { TaskTrashWarningDialog } from "@/components/task-trash-warning-dialog";
import { GitBranchStatusControl, TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { createInitialBoardData } from "@/data/board-data";
import { createIdleTaskSession } from "@/hooks/app-utils";
import { QuarterdeckAccessBlockedFallback } from "@/hooks/quarterdeck-access-blocked-fallback";
import { RuntimeDisconnectedFallback } from "@/hooks/runtime-disconnected-fallback";
import { useAppHotkeys } from "@/hooks/use-app-hotkeys";
import { useAudibleNotifications } from "@/hooks/use-audible-notifications";
import { useBoardMetadataSync } from "@/hooks/use-board-metadata-sync";
import { useDisplaySummaryOnHover } from "@/hooks/use-display-summary";
import { useEscapeHandler } from "@/hooks/use-escape-handler";
import { useFocusedTaskNotification } from "@/hooks/use-focused-task-notification";
import { useMigrateTaskDialog } from "@/hooks/use-migrate-task-dialog";
import { useNavbarState } from "@/hooks/use-navbar-state";
import { useProjectSwitchCleanup } from "@/hooks/use-project-switch-cleanup";
import { useProjectUiState } from "@/hooks/use-project-ui-state";
import { usePromptShortcuts } from "@/hooks/use-prompt-shortcuts";
import { useReviewReadyNotifications } from "@/hooks/use-review-ready-notifications";
import { useShortcutActions } from "@/hooks/use-shortcut-actions";
import { useStreamErrorHandler } from "@/hooks/use-stream-error-handler";
import { useTaskTitleSync } from "@/hooks/use-task-title-sync";
import { useTerminalConfigSync } from "@/hooks/use-terminal-config-sync";
import { useTitleActions } from "@/hooks/use-title-actions";
import { BoardProvider, useBoardContext } from "@/providers/board-provider";
import { DialogProvider, useDialogContext } from "@/providers/dialog-provider";
import { GitProvider, useGitContext } from "@/providers/git-provider";
import { InteractionsProvider, useInteractionsContext } from "@/providers/interactions-provider";
import { ProjectProvider, useProjectContext } from "@/providers/project-provider";
import { TerminalProvider, useTerminalContext } from "@/providers/terminal-provider";
import { LayoutCustomizationsProvider, useLayoutResetEffect } from "@/resize/layout-customizations";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import { ResizeHandle } from "@/resize/resize-handle";
import type { MainViewId } from "@/resize/use-card-detail-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { saveWorkspaceState } from "@/runtime/workspace-state-query";
import { findCardSelection, toggleTaskPinned } from "@/state/board-state";
import { CardActionsProvider, type ReactiveCardState, type StableCardActions } from "@/state/card-actions-context";
import {
	useHomeGitSummaryValue,
	useTaskWorkspaceInfoValue,
	useTaskWorkspaceSnapshotValue,
} from "@/stores/workspace-metadata-store";
import { cancelWarmup, initPool, warmup } from "@/terminal/terminal-pool";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardData } from "@/types";
import { isApprovalState } from "@/utils/session-status";

initPool();

/**
 * Bridge component that connects `useCardDetailLayout`'s reset callback to the
 * `LayoutCustomizationsProvider`. Must be rendered *inside* the provider tree so
 * `useLayoutResetEffect` can observe the `layoutResetNonce`.
 */
function LayoutResetBridge({ resetToDefaults }: { resetToDefaults: () => void }): null {
	useLayoutResetEffect(resetToDefaults);
	return null;
}

// ---------------------------------------------------------------------------
// AppContentProps — values AppContent needs that aren't in any context.
// ---------------------------------------------------------------------------

interface AppContentProps {
	// pendingTaskStartAfterEditId state (owned by App for project-switch reset)
	pendingTaskStartAfterEditId: string | null;
	clearPendingTaskStartAfterEditId: () => void;
}

// ---------------------------------------------------------------------------
// AppEarlyBailout — renders fallback UIs for disconnected/blocked states.
// Must be inside ProjectProvider so it can read useProjectContext().
// ---------------------------------------------------------------------------

function AppEarlyBailout({ children }: { children: ReactNode }): ReactNode {
	const { isRuntimeDisconnected, isQuarterdeckAccessBlocked } = useProjectContext();

	if (isRuntimeDisconnected) {
		return <RuntimeDisconnectedFallback />;
	}
	if (isQuarterdeckAccessBlocked) {
		return <QuarterdeckAccessBlockedFallback />;
	}
	return children;
}

// ---------------------------------------------------------------------------
// App — top-level shell: owns state atoms, renders the provider tree.
// ---------------------------------------------------------------------------

export default function App(): ReactElement {
	const [board, setBoard] = useState<BoardData>(() => createInitialBoardData());
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [canPersistWorkspaceState, setCanPersistWorkspaceState] = useState(false);
	const [isGitHistoryOpen, setIsGitHistoryOpen] = useState(false);
	const [pendingTaskStartAfterEditId, setPendingTaskStartAfterEditId] = useState<string | null>(null);
	const taskEditorResetRef = useRef<() => void>(() => {});

	const handleProjectSwitchStart = useCallback(() => {
		setCanPersistWorkspaceState(false);
		setIsGitHistoryOpen(false);
		setPendingTaskStartAfterEditId(null);
		taskEditorResetRef.current();
	}, []);

	return (
		<ProjectProvider
			onProjectSwitchStart={handleProjectSwitchStart}
			setBoard={setBoard}
			setSessions={setSessions}
			canPersistWorkspaceState={canPersistWorkspaceState}
			setCanPersistWorkspaceState={setCanPersistWorkspaceState}
		>
			<AppEarlyBailout>
				<BoardProvider
					board={board}
					setBoard={setBoard}
					sessions={sessions}
					setSessions={setSessions}
					setPendingTaskStartAfterEditId={setPendingTaskStartAfterEditId}
					taskEditorResetRef={taskEditorResetRef}
				>
					<GitProvider isGitHistoryOpen={isGitHistoryOpen} setIsGitHistoryOpen={setIsGitHistoryOpen}>
						<TerminalProvider>
							<InteractionsProvider setIsGitHistoryOpen={setIsGitHistoryOpen}>
								<DialogProvider>
									<AppContent
										pendingTaskStartAfterEditId={pendingTaskStartAfterEditId}
										clearPendingTaskStartAfterEditId={() => setPendingTaskStartAfterEditId(null)}
									/>
								</DialogProvider>
							</InteractionsProvider>
						</TerminalProvider>
					</GitProvider>
				</BoardProvider>
			</AppEarlyBailout>
		</ProjectProvider>
	);
}

// ---------------------------------------------------------------------------
// AppContent — inner component: rendered inside the provider tree.
// Reads from the 6 contexts, runs side-effect hooks, renders all JSX.
// ---------------------------------------------------------------------------

function AppContent({ pendingTaskStartAfterEditId, clearPendingTaskStartAfterEditId }: AppContentProps): ReactElement {
	const project = useProjectContext();
	const {
		board,
		setBoard,
		sessions,
		upsertSession,
		selectedTaskId,
		selectedCard,
		setSelectedTaskId,
		sendTaskSessionInput,
		stopTaskSession,
		taskEditor,
		createTaskBranchOptions,
		isAwaitingWorkspaceSnapshot,
	} = useBoardContext();
	const git = useGitContext();
	const terminal = useTerminalContext();
	const interactions = useInteractionsContext();
	const dialog = useDialogContext();

	// --- Store subscriptions + derived UI state ---

	const selectedTaskWorkspaceInfo = useTaskWorkspaceInfoValue(selectedCard?.card.id, selectedCard?.card.baseRef);
	const selectedTaskWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(selectedCard?.card.id);
	const homeGitSummary = useHomeGitSummaryValue();

	const {
		displayedProjects,
		navigationProjectPath,
		shouldShowProjectLoadingState,
		isProjectListLoading,
		shouldUseNavigationPath,
	} = useProjectUiState({
		board,
		canPersistWorkspaceState: project.canPersistWorkspaceState,
		currentProjectId: project.currentProjectId,
		projects: project.projects,
		navigationCurrentProjectId: project.navigationCurrentProjectId,
		selectedTaskId,
		streamError: project.streamError,
		isProjectSwitching: project.isProjectSwitching,
		isInitialRuntimeLoad:
			!project.hasReceivedSnapshot &&
			project.currentProjectId === null &&
			project.projects.length === 0 &&
			!project.streamError,
		isAwaitingWorkspaceSnapshot,
		isWorkspaceMetadataPending: project.isWorkspaceMetadataPending,
		hasReceivedSnapshot: project.hasReceivedSnapshot,
	});

	const serverMutationInFlightRef = useRef(false);

	// --- Side-effect hooks ---

	useFocusedTaskNotification({ currentProjectId: project.currentProjectId, selectedTaskId });
	useBoardMetadataSync({ workspaceMetadata: project.workspaceMetadata, setBoard });
	useReviewReadyNotifications({
		activeWorkspaceId: project.navigationCurrentProjectId,
		latestTaskReadyForReview: project.latestTaskReadyForReview,
		workspacePath: project.workspacePath,
	});

	const trashTaskIdSet = useMemo(() => {
		const trashColumn = board.columns.find((col) => col.id === "trash");
		return trashColumn ? new Set(trashColumn.cards.map((c) => c.id)) : new Set<string>();
	}, [board.columns]);

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

	useTerminalConfigSync({
		terminalFontWeight: project.terminalFontWeight,
		terminalWebGLRenderer: project.terminalWebGLRenderer,
	});
	useTaskTitleSync({ latestTaskTitleUpdate: project.latestTaskTitleUpdate, setBoard });
	useStreamErrorHandler({ streamError: project.streamError, isRuntimeDisconnected: project.isRuntimeDisconnected });

	useProjectSwitchCleanup({
		currentProjectId: project.currentProjectId,
		isProjectSwitching: project.isProjectSwitching,
		resetTaskEditorState: taskEditor.resetTaskEditorState,
		setIsClearTrashDialogOpen: dialog.setIsClearTrashDialogOpen as Dispatch<SetStateAction<boolean>>,
		resetGitActionState: git.resetGitActionState,
		resetProjectNavigationState: project.resetProjectNavigationState,
		resetTerminalPanelsState: terminal.resetTerminalPanelsState,
		resetWorkspaceSyncState: project.resetWorkspaceSyncState,
	});

	useEffect(() => {
		if (selectedCard) return;
		if (project.hasNoProjects || !project.currentProjectId) {
			if (terminal.isHomeTerminalOpen) terminal.closeHomeTerminal();
			return;
		}
	}, [
		terminal.closeHomeTerminal,
		project.currentProjectId,
		project.hasNoProjects,
		terminal.isHomeTerminalOpen,
		selectedCard,
	]);

	useAppHotkeys({
		selectedCard,
		isDetailTerminalOpen: terminal.isDetailTerminalOpen,
		isHomeTerminalOpen: terminal.showHomeBottomTerminal,
		canUseCreateTaskShortcut: !project.hasNoProjects && project.currentProjectId !== null,
		handleToggleDetailTerminal: terminal.handleToggleDetailTerminal,
		handleToggleHomeTerminal: terminal.handleToggleHomeTerminal,
		handleToggleExpandDetailTerminal: terminal.handleToggleExpandDetailTerminal,
		handleToggleExpandHomeTerminal: terminal.handleToggleExpandHomeTerminal,
		handleOpenCreateTask: taskEditor.handleOpenCreateTask,
		handleOpenSettings: dialog.handleOpenSettings,
		handleToggleGitHistory: git.handleToggleGitHistory,
		onStartAllTasks: interactions.handleStartAllBacklogTasksFromBoard,
		handleToggleDebugLogPanel: dialog.debugLogging.toggleDebugLogPanel,
	});

	useEscapeHandler({
		isGitHistoryOpen: git.isGitHistoryOpen,
		setIsGitHistoryOpen: git.setIsGitHistoryOpen,
		selectedCard,
		setSelectedTaskId,
	});

	// --- Workspace persistence ---

	const persistWorkspaceStateAsync = useCallback(
		async (input: { workspaceId: string; payload: Parameters<typeof saveWorkspaceState>[1] }) =>
			await saveWorkspaceState(input.workspaceId, input.payload),
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
			"workspace-state-conflict",
		);
	}, []);

	useWorkspacePersistence({
		board,
		sessions,
		currentProjectId: project.currentProjectId,
		workspaceRevision: project.workspaceRevision,
		hydrationNonce: project.workspaceHydrationNonce,
		canPersistWorkspaceState: project.canPersistWorkspaceState,
		isDocumentVisible: project.isDocumentVisible,
		isWorkspaceStateRefreshing: project.isWorkspaceStateRefreshing,
		persistWorkspaceState: persistWorkspaceStateAsync,
		refetchWorkspaceState: project.refreshWorkspaceState,
		onWorkspaceRevisionChange: project.setWorkspaceRevision,
		onWorkspaceStateConflict: handleWorkspaceStateConflict,
	});

	// --- pendingTaskStartAfterEditId effect ---

	useEffect(() => {
		if (!pendingTaskStartAfterEditId) return;
		const selection = findCardSelection(board, pendingTaskStartAfterEditId);
		if (!selection || selection.column.id !== "backlog") return;
		interactions.handleStartTaskFromBoard(pendingTaskStartAfterEditId);
		clearPendingTaskStartAfterEditId();
	}, [board, interactions.handleStartTaskFromBoard, pendingTaskStartAfterEditId, clearPendingTaskStartAfterEditId]);

	// --- JSX-producing hooks ---

	const handleRequestDisplaySummary = useDisplaySummaryOnHover(
		project.currentProjectId,
		project.runtimeProjectConfig?.autoGenerateSummary ?? CONFIG_DEFAULTS.autoGenerateSummary,
		project.runtimeProjectConfig?.summaryStaleAfterSeconds ?? CONFIG_DEFAULTS.summaryStaleAfterSeconds,
		project.llmConfigured,
	);

	const handleTerminalWarmup = useCallback(
		(taskId: string) => {
			if (project.currentProjectId) warmup(taskId, project.currentProjectId);
		},
		[project.currentProjectId],
	);
	const handleTerminalCancelWarmup = useCallback(
		(taskId: string) => {
			if (project.currentProjectId) cancelWarmup(taskId);
		},
		[project.currentProjectId],
	);

	const { runningShortcutLabel, handleSelectShortcutLabel, handleRunShortcut, handleCreateShortcut } =
		useShortcutActions({
			currentProjectId: project.currentProjectId,
			selectedShortcutLabel: project.runtimeProjectConfig?.selectedShortcutLabel,
			shortcuts: project.shortcuts,
			refreshRuntimeProjectConfig: project.refreshRuntimeProjectConfig,
			prepareTerminalForShortcut: terminal.prepareTerminalForShortcut,
			prepareWaitForTerminalConnectionReady: terminal.prepareWaitForTerminalConnectionReady,
			sendTaskSessionInput,
		});

	const {
		activeShortcut: activePromptShortcut,
		isRunning: isPromptShortcutRunning,
		runPromptShortcut,
		selectShortcutLabel: selectPromptShortcutLabel,
		savePromptShortcuts,
	} = usePromptShortcuts({
		currentProjectId: project.currentProjectId,
		promptShortcuts: project.runtimeProjectConfig?.promptShortcuts ?? [],
		refreshRuntimeConfig: project.refreshRuntimeProjectConfig,
		sendTaskSessionInput,
	});

	const { handleRegenerateTitleTask, handleUpdateTaskTitle } = useTitleActions({
		currentProjectId: project.currentProjectId,
	});

	const handleToggleTaskPinned = useCallback(
		(taskId: string) => {
			setBoard((prev) => toggleTaskPinned(prev, taskId).board);
		},
		[setBoard],
	);

	const { pendingMigrate, migratingTaskId, handleMigrateWorkingDirectory, handleConfirmMigrate, cancelMigrate } =
		useMigrateTaskDialog({
			currentProjectId: project.currentProjectId,
			serverMutationInFlightRef: serverMutationInFlightRef,
			stopTaskSession,
			refreshWorkspaceState: project.refreshWorkspaceState,
		});

	const handleMainViewChange = useCallback(
		(view: MainViewId) => {
			git.setMainView(view, { setSelectedTaskId });
		},
		[git.setMainView, setSelectedTaskId],
	);

	const handleCardDoubleClick = useCallback(
		(taskId: string) => {
			interactions.handleCardSelect(taskId);
			git.setMainView("terminal", { setSelectedTaskId });
		},
		[interactions.handleCardSelect, git.setMainView, setSelectedTaskId],
	);

	// --- Home side panel resize ---
	const { startDrag: startHomeSidePanelResize } = useResizeDrag();
	const sidebarAreaRef = useRef<HTMLDivElement | null>(null);

	const handleHomeSidePanelSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = sidebarAreaRef.current;
			if (!container) return;
			const containerWidth = Math.max(container.offsetWidth - TOOLBAR_WIDTH, 1);
			const startX = event.clientX;
			const startRatio = git.sidePanelRatio;
			startHomeSidePanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaRatio = (pointerX - startX) / containerWidth;
					git.setSidePanelRatio(startRatio + deltaRatio);
				},
				onEnd: (pointerX) => {
					const deltaRatio = (pointerX - startX) / containerWidth;
					git.setSidePanelRatio(startRatio + deltaRatio);
				},
			});
		},
		[git.setSidePanelRatio, startHomeSidePanelResize, git.sidePanelRatio],
	);

	const { navbarWorkspacePath, navbarWorkspaceHint, navbarRuntimeHint, shouldHideProjectDependentTopBarActions } =
		useNavbarState({
			selectedCard,
			selectedTaskWorkspaceInfo: selectedTaskWorkspaceInfo,
			selectedTaskWorkspaceSnapshot: selectedTaskWorkspaceSnapshot,
			workspacePath: project.workspacePath,
			shouldUseNavigationPath: shouldUseNavigationPath,
			navigationProjectPath: navigationProjectPath,
			runtimeProjectConfig: project.runtimeProjectConfig,
			hasNoProjects: project.hasNoProjects,
			isProjectSwitching: project.isProjectSwitching,
			isAwaitingWorkspaceSnapshot: isAwaitingWorkspaceSnapshot,
			isWorkspaceMetadataPending: project.isWorkspaceMetadataPending,
		});

	// Destructure taskEditor for JSX usage
	const {
		editingTaskId,
		editTaskPrompt,
		setEditTaskPrompt,
		editTaskImages,
		setEditTaskImages,
		editTaskStartInPlanMode,
		setEditTaskStartInPlanMode,
		editTaskAutoReviewEnabled,
		setEditTaskAutoReviewEnabled,
		isEditTaskStartInPlanModeDisabled,
		editTaskBranchRef,
		setEditTaskBranchRef,
		handleOpenCreateTask,
		handleCancelEditTask,
		handleSaveEditedTask,
		handleSaveAndStartEditedTask,
		handleOpenEditTask,
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
		isNewTaskStartInPlanModeDisabled,
		newTaskUseWorktree,
		setNewTaskUseWorktree,
		createFeatureBranch,
		setCreateFeatureBranch,
		branchName,
		handleBranchNameEdit,
		generateBranchNameFromPrompt,
		isGeneratingBranchName,
		newTaskBranchRef,
		setNewTaskBranchRef,
		handleCreateTask,
		handleCreateTasks,
	} = taskEditor;

	const inlineTaskEditor = editingTaskId ? (
		<TaskInlineCreateCard
			prompt={editTaskPrompt}
			onPromptChange={setEditTaskPrompt}
			images={editTaskImages}
			onImagesChange={setEditTaskImages}
			onCreate={handleSaveEditedTask}
			onCreateAndStart={handleSaveAndStartEditedTask}
			onCancel={handleCancelEditTask}
			startInPlanMode={editTaskStartInPlanMode}
			onStartInPlanModeChange={setEditTaskStartInPlanMode}
			startInPlanModeDisabled={isEditTaskStartInPlanModeDisabled}
			autoReviewEnabled={editTaskAutoReviewEnabled}
			onAutoReviewEnabledChange={setEditTaskAutoReviewEnabled}
			workspaceId={project.currentProjectId}
			branchRef={editTaskBranchRef}
			branchOptions={createTaskBranchOptions}
			onBranchRefChange={setEditTaskBranchRef}
			defaultBaseRef={project.configDefaultBaseRef}
			onSetDefaultBaseRef={project.handleSetDefaultBaseRef}
			mode="edit"
			idPrefix={`inline-edit-task-${editingTaskId}`}
		/>
	) : undefined;

	const handleFlagForDebug = useCallback(
		(taskId: string) => {
			if (!project.currentProjectId) return;
			getRuntimeTrpcClient(project.currentProjectId)
				.runtime.flagTaskForDebug.mutate({ taskId })
				.then((result) => {
					if (result.ok) showAppToast({ message: "Flagged in event log", intent: "success", timeout: 2000 });
				})
				.catch(() => {});
		},
		[project.currentProjectId],
	);

	const stableCardActions = useMemo<StableCardActions>(
		() => ({
			onStartTask: interactions.handleStartTaskFromBoard,
			onRestartSessionTask: interactions.handleRestartTaskSession,
			onMoveToTrashTask: interactions.handleMoveReviewCardToTrash,
			onRestoreFromTrashTask: interactions.handleRestoreTaskFromTrash,
			onHardDeleteTrashTask: interactions.handleHardDeleteTrashTask,
			onCancelAutomaticTaskAction: interactions.handleCancelAutomaticTaskAction,
			onRegenerateTitleTask: handleRegenerateTitleTask,
			onUpdateTaskTitle: handleUpdateTaskTitle,
			onTogglePinTask: handleToggleTaskPinned,
			onMigrateWorkingDirectory: handleMigrateWorkingDirectory,
			onRequestDisplaySummary: handleRequestDisplaySummary,
			onTerminalWarmup: handleTerminalWarmup,
			onTerminalCancelWarmup: handleTerminalCancelWarmup,
			onFlagForDebug: project.runtimeProjectConfig?.eventLogEnabled ? handleFlagForDebug : undefined,
		}),
		[
			interactions.handleStartTaskFromBoard,
			interactions.handleRestartTaskSession,
			interactions.handleMoveReviewCardToTrash,
			interactions.handleRestoreTaskFromTrash,
			interactions.handleHardDeleteTrashTask,
			interactions.handleCancelAutomaticTaskAction,
			handleRegenerateTitleTask,
			handleUpdateTaskTitle,
			handleToggleTaskPinned,
			handleMigrateWorkingDirectory,
			handleRequestDisplaySummary,
			handleTerminalWarmup,
			handleTerminalCancelWarmup,
			handleFlagForDebug,
			project.runtimeProjectConfig?.eventLogEnabled,
		],
	);

	const reactiveCardState = useMemo<ReactiveCardState>(
		() => ({
			moveToTrashLoadingById: interactions.moveToTrashLoadingById ?? {},
			migratingTaskId: migratingTaskId ?? null,
			isLlmGenerationDisabled: project.isLlmGenerationDisabled,
			showSummaryOnCards: project.runtimeProjectConfig?.showSummaryOnCards ?? CONFIG_DEFAULTS.showSummaryOnCards,
			uncommittedChangesOnCardsEnabled:
				project.runtimeProjectConfig?.uncommittedChangesOnCardsEnabled ??
				CONFIG_DEFAULTS.uncommittedChangesOnCardsEnabled,
			showRunningTaskEmergencyActions:
				project.runtimeProjectConfig?.showRunningTaskEmergencyActions ??
				CONFIG_DEFAULTS.showRunningTaskEmergencyActions,
		}),
		[
			interactions.moveToTrashLoadingById,
			migratingTaskId,
			project.isLlmGenerationDisabled,
			project.runtimeProjectConfig?.showSummaryOnCards,
			project.runtimeProjectConfig?.uncommittedChangesOnCardsEnabled,
			project.runtimeProjectConfig?.showRunningTaskEmergencyActions,
		],
	);

	const projectsBadgeColor: "orange" | undefined = useMemo(
		() =>
			Object.entries(project.notificationSessions).some(
				([taskId, session]) =>
					project.notificationWorkspaceIds[taskId] !== project.currentProjectId && isApprovalState(session),
			)
				? "orange"
				: undefined,
		[project.notificationSessions, project.notificationWorkspaceIds, project.currentProjectId],
	);

	const boardBadgeColor: "orange" | undefined = useMemo(
		() =>
			Object.entries(project.notificationSessions).some(
				([taskId, session]) =>
					project.notificationWorkspaceIds[taskId] === project.currentProjectId && isApprovalState(session),
			)
				? "orange"
				: undefined,
		[project.notificationSessions, project.notificationWorkspaceIds, project.currentProjectId],
	);

	const homeSidePanelPercent = `${(git.sidePanelRatio * 100).toFixed(1)}%`;

	const handleBack = useCallback(() => {
		setSelectedTaskId(null);
		git.setIsGitHistoryOpen(false);
	}, [setSelectedTaskId, git.setIsGitHistoryOpen]);

	const detailSession = selectedCard
		? (sessions[selectedCard.card.id] ?? createIdleTaskSession(selectedCard.card.id))
		: null;

	const topBar = (
		<TopBar
			onBack={selectedCard ? handleBack : undefined}
			workspacePath={navbarWorkspacePath}
			isWorkspacePathLoading={shouldShowProjectLoadingState}
			workspaceHint={navbarWorkspaceHint}
			runtimeHint={navbarRuntimeHint}
			selectedTaskId={selectedCard?.card.id ?? null}
			scopeType={selectedCard ? "task" : (git.fileBrowserResolvedScope?.type ?? "home")}
			taskTitle={selectedCard?.card.title ?? null}
			onToggleTerminal={
				project.hasNoProjects
					? undefined
					: selectedCard
						? terminal.handleToggleDetailTerminal
						: terminal.handleToggleHomeTerminal
			}
			isTerminalOpen={selectedCard ? terminal.isDetailTerminalOpen : terminal.showHomeBottomTerminal}
			isTerminalLoading={selectedCard ? terminal.isDetailTerminalStarting : terminal.isHomeTerminalStarting}
			onOpenSettings={dialog.handleOpenSettings}
			showDebugButton={dialog.debugModeEnabled}
			onOpenDebugDialog={dialog.debugModeEnabled ? dialog.handleOpenDebugDialog : undefined}
			shortcuts={project.shortcuts}
			selectedShortcutLabel={project.selectedShortcutLabel}
			onSelectShortcutLabel={handleSelectShortcutLabel}
			runningShortcutLabel={runningShortcutLabel}
			onRunShortcut={handleRunShortcut}
			onCreateFirstShortcut={project.currentProjectId ? handleCreateShortcut : undefined}
			promptShortcuts={project.runtimeProjectConfig?.promptShortcuts ?? []}
			activePromptShortcut={activePromptShortcut}
			onSelectPromptShortcutLabel={selectPromptShortcutLabel}
			isPromptShortcutRunning={isPromptShortcutRunning}
			onRunPromptShortcut={runPromptShortcut}
			onManagePromptShortcuts={() => dialog.setPromptShortcutEditorOpen(true)}
			hideProjectDependentActions={shouldHideProjectDependentTopBarActions}
			branchPillSlot={
				git.topbarBranchLabel ? (
					<div className="flex items-center gap-1.5">
						<BranchSelectorPopover
							isOpen={git.topbarBranchActions.isBranchPopoverOpen}
							onOpenChange={git.topbarBranchActions.setBranchPopoverOpen}
							branches={git.topbarBranchActions.branches}
							currentBranch={git.topbarBranchActions.currentBranch}
							worktreeBranches={git.topbarBranchActions.worktreeBranches}
							onSelectBranchView={git.topbarBranchActions.handleSelectBranchView}
							onCheckoutBranch={git.topbarBranchActions.handleCheckoutBranch}
							onCompareWithBranch={(branch) => git.openGitCompare({ targetRef: branch })}
							onMergeBranch={git.topbarBranchActions.handleMergeBranch}
							onCreateBranch={git.topbarBranchActions.handleCreateBranchFrom}
							onDeleteBranch={git.topbarBranchActions.handleDeleteBranch}
							onPull={(branch) => {
								void git.runGitAction("pull", git.gitSyncTaskScope ?? null, branch);
							}}
							onPush={(branch) => {
								void git.runGitAction("push", git.gitSyncTaskScope ?? null, branch);
							}}
							pinnedBranches={project.pinnedBranches}
							onTogglePinBranch={project.handleTogglePinBranch}
							trigger={
								<BranchPillTrigger
									label={git.topbarBranchLabel}
									aheadCount={!selectedCard ? homeGitSummary?.aheadCount : undefined}
									behindCount={!selectedCard ? homeGitSummary?.behindCount : undefined}
								/>
							}
						/>
						{selectedCard?.card.baseRef ? (
							<span className="text-xs text-text-tertiary whitespace-nowrap">
								from <span className="font-mono">{selectedCard.card.baseRef}</span>
								{(selectedTaskWorkspaceSnapshot?.behindBaseCount ?? 0) > 0 ? (
									<span className="text-status-blue">
										{" "}
										({selectedTaskWorkspaceSnapshot?.behindBaseCount} behind)
									</span>
								) : null}
							</span>
						) : null}
						<div className="flex">
							<Tooltip side="bottom" content="Fetch latest refs from upstream">
								<Button
									variant="ghost"
									size="sm"
									className="h-6"
									icon={
										git.runningGitAction === "fetch" ? <Spinner size={12} /> : <CircleArrowDown size={14} />
									}
									onClick={() => {
										void git.runGitAction("fetch", git.gitSyncTaskScope);
									}}
									disabled={git.runningGitAction != null}
									aria-label="Fetch from upstream"
								/>
							</Tooltip>
							<Tooltip side="bottom" content="Pull from upstream">
								<Button
									variant="ghost"
									size="sm"
									className="h-6"
									icon={git.runningGitAction === "pull" ? <Spinner size={12} /> : <ArrowDown size={12} />}
									onClick={() => {
										void git.runGitAction("pull", git.gitSyncTaskScope);
									}}
									disabled={git.runningGitAction != null}
									aria-label="Pull from upstream"
								/>
							</Tooltip>
							<Tooltip side="bottom" content="Push to upstream">
								<Button
									variant="ghost"
									size="sm"
									className="h-6"
									icon={git.runningGitAction === "push" ? <Spinner size={12} /> : <ArrowUp size={12} />}
									onClick={() => {
										void git.runGitAction("push", git.gitSyncTaskScope);
									}}
									disabled={git.runningGitAction != null}
									aria-label="Push to upstream"
								/>
							</Tooltip>
						</div>
					</div>
				) : undefined
			}
		/>
	);

	return (
		<CardActionsProvider stable={stableCardActions} reactive={reactiveCardState}>
			<LayoutCustomizationsProvider
				onResetBottomTerminalLayoutCustomizations={terminal.resetBottomTerminalLayoutCustomizations}
			>
				<LayoutResetBridge resetToDefaults={git.resetCardDetailLayoutToDefaults} />
				<div ref={sidebarAreaRef} className="flex h-[100svh] min-w-0 overflow-hidden">
					{/* Sidebar toolbar + side panel */}
					<>
						<DetailToolbar
							activeMainView={git.visualMainView}
							activeSidebar={git.visualSidebar}
							onMainViewChange={handleMainViewChange}
							onSidebarChange={git.toggleSidebar}
							sidebarPinned={git.sidebarPinned}
							onToggleSidebarPinned={git.toggleSidebarPinned}
							hasSelectedTask={selectedCard !== null}
							gitBadgeColor={
								selectedCard
									? (selectedTaskWorkspaceSnapshot?.changedFiles ?? 0) > 0
										? "red"
										: project.unmergedChangesIndicatorEnabled &&
												(selectedTaskWorkspaceSnapshot?.hasUnmergedChanges ?? false)
											? "blue"
											: undefined
									: (homeGitSummary?.changedFiles ?? 0) > 0
										? "red"
										: undefined
							}
							isBehindBase={
								project.behindBaseIndicatorEnabled && selectedCard
									? (selectedTaskWorkspaceSnapshot?.behindBaseCount ?? 0) > 0
									: false
							}
							projectsBadgeColor={projectsBadgeColor}
							boardBadgeColor={selectedCard ? boardBadgeColor : undefined}
						/>

						{git.sidebar === "commit" && !selectedCard ? (
							<>
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										flex: `0 0 ${homeSidePanelPercent}`,
										minWidth: 0,
										minHeight: 0,
										overflow: "hidden",
									}}
								>
									<CommitPanel
										workspaceId={project.currentProjectId ?? ""}
										taskId={null}
										baseRef={null}
										navigateToFile={git.navigateToFile}
									/>
								</div>
								<ResizeHandle
									orientation="vertical"
									ariaLabel="Resize home side panel"
									onMouseDown={handleHomeSidePanelSeparatorMouseDown}
									className="z-10"
								/>
							</>
						) : git.sidebar === "projects" || (git.sidebar !== null && !selectedCard) ? (
							<>
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										flex: `0 0 ${homeSidePanelPercent}`,
										minWidth: 0,
										minHeight: 0,
										overflow: "hidden",
									}}
								>
									<ProjectNavigationPanel
										projects={displayedProjects}
										isLoadingProjects={isProjectListLoading}
										currentProjectId={project.navigationCurrentProjectId}
										removingProjectId={project.removingProjectId}
										onSelectProject={(projectId) => {
											void project.handleSelectProject(projectId);
										}}
										onPreloadProject={project.handlePreloadProject}
										onRemoveProject={project.handleRemoveProject}
										onReorderProjects={project.handleReorderProjects}
										onAddProject={() => {
											void project.handleAddProject();
										}}
										notificationSessions={project.notificationSessions}
										notificationWorkspaceIds={project.notificationWorkspaceIds}
									/>
								</div>
								<ResizeHandle
									orientation="vertical"
									ariaLabel="Resize home side panel"
									onMouseDown={handleHomeSidePanelSeparatorMouseDown}
									className="z-10"
								/>
							</>
						) : null}
					</>

					{/* Main area */}
					{selectedCard && detailSession ? (
						<CardDetailView
							selection={selectedCard}
							currentProjectId={project.currentProjectId}
							sessionSummary={detailSession}
							onCardSelect={interactions.handleCardSelect}
							onCardDoubleClick={handleCardDoubleClick}
							onCreateTask={handleOpenCreateTask}
							onStartAllTasks={interactions.handleStartAllBacklogTasksFromBoard}
							onClearTrash={interactions.handleOpenClearTrash}
							editingTaskId={editingTaskId}
							inlineTaskEditor={inlineTaskEditor}
							onEditTask={(task) => {
								handleOpenEditTask(task, { preserveDetailSelection: true });
							}}
							gitHistoryPanel={
								git.isGitHistoryOpen ? (
									<GitHistoryView
										workspaceId={project.currentProjectId}
										gitHistory={git.gitHistory}
										onCreateBranch={git.fileBrowserBranchActions.handleCreateBranchFrom}
										onPullLatest={() => {
											void git.runGitAction("pull", git.gitHistoryTaskScope);
										}}
										taskScope={git.gitHistoryTaskScope}
										skipCherryPickConfirmation={project.skipCherryPickConfirmation}
									/>
								) : undefined
							}
							bottomTerminalOpen={terminal.isDetailTerminalOpen}
							bottomTerminalTaskId={terminal.detailTerminalTaskId}
							bottomTerminalSummary={terminal.detailTerminalSummary}
							bottomTerminalSubtitle={terminal.detailTerminalSubtitle}
							onBottomTerminalClose={terminal.closeDetailTerminal}
							onBottomTerminalCollapse={terminal.collapseDetailTerminal}
							bottomTerminalPaneHeight={terminal.detailTerminalPaneHeight}
							onBottomTerminalPaneHeightChange={terminal.setDetailTerminalPaneHeight}
							onBottomTerminalConnectionReady={terminal.markTerminalConnectionReady}
							bottomTerminalAgentCommand={project.agentCommand}
							onBottomTerminalSendAgentCommand={terminal.handleSendAgentCommandToDetailTerminal}
							isBottomTerminalExpanded={terminal.isDetailTerminalExpanded}
							onBottomTerminalToggleExpand={terminal.handleToggleExpandDetailTerminal}
							onBottomTerminalRestart={terminal.handleRestartDetailTerminal}
							onBottomTerminalExit={terminal.handleShellExit}
							mainView={git.mainView}
							sidebar={git.sidebar}
							topBar={topBar}
							sidePanelRatio={git.sidePanelRatio}
							setSidePanelRatio={git.setSidePanelRatio}
							skipTaskCheckoutConfirmation={project.skipTaskCheckoutConfirmation}
							skipHomeCheckoutConfirmation={project.skipHomeCheckoutConfirmation}
							onSkipTaskCheckoutConfirmationChange={project.handleSkipTaskCheckoutConfirmationChange}
							onDeselectTask={() => setSelectedTaskId(null)}
							pinnedBranches={project.pinnedBranches}
							onTogglePinBranch={project.handleTogglePinBranch}
						/>
					) : (
						<div className="flex flex-col flex-1 min-w-0 overflow-hidden">
							{topBar}
							{git.mainView !== "git" && (
								<ConflictBanner
									taskId={selectedTaskId}
									onNavigateToResolver={() => git.navigateToGitViewRef.current?.()}
								/>
							)}
							<div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
								{shouldShowProjectLoadingState ? (
									<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0">
										<Spinner size={30} />
									</div>
								) : project.hasNoProjects ? (
									<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0 p-6">
										<div className="flex flex-col items-center justify-center gap-3 text-text-tertiary">
											<FolderOpen size={48} strokeWidth={1} />
											<h3 className="text-sm font-semibold text-text-primary">No projects yet</h3>
											<p className="text-[13px] text-text-secondary">
												Add a git repository to start using Quarterdeck.
											</p>
											<Button
												variant="primary"
												onClick={() => {
													void project.handleAddProject();
												}}
											>
												Add Project
											</Button>
										</div>
									</div>
								) : (
									<div className="flex flex-1 flex-col min-h-0 min-w-0">
										<div className="flex flex-1 min-h-0 min-w-0">
											{git.mainView === "git" ? (
												<GitView
													currentProjectId={project.currentProjectId}
													selectedCard={null}
													sessionSummary={null}
													homeGitSummary={homeGitSummary}
													board={board}
													pendingCompareNavigation={git.pendingCompareNavigation}
													onCompareNavigationConsumed={git.clearPendingCompareNavigation}
													pendingFileNavigation={git.pendingFileNavigation}
													onFileNavigationConsumed={git.clearPendingFileNavigation}
													navigateToFile={git.navigateToFile}
													pinnedBranches={project.pinnedBranches}
													onTogglePinBranch={project.handleTogglePinBranch}
													branchStatusSlot={
														homeGitSummary ? (
															<GitBranchStatusControl
																branchLabel={homeGitSummary.currentBranch ?? "detached HEAD"}
																changedFiles={homeGitSummary.changedFiles ?? 0}
																additions={homeGitSummary.additions ?? 0}
																deletions={homeGitSummary.deletions ?? 0}
																onToggleGitHistory={git.handleToggleGitHistory}
																isGitHistoryOpen={git.isGitHistoryOpen}
															/>
														) : undefined
													}
													gitHistoryPanel={
														git.isGitHistoryOpen ? (
															<GitHistoryView
																workspaceId={project.currentProjectId}
																gitHistory={git.gitHistory}
																onCheckoutBranch={(branch) => {
																	void git.switchHomeBranch(branch);
																}}
																onCreateBranch={git.fileBrowserBranchActions.handleCreateBranchFrom}
																onPullLatest={() => {
																	void git.runGitAction("pull");
																}}
																taskScope={git.gitHistoryTaskScope}
																skipCherryPickConfirmation={project.skipCherryPickConfirmation}
															/>
														) : undefined
													}
												/>
											) : git.mainView === "files" ? (
												<FilesView
													key={project.currentProjectId ?? "no-project"}
													scopeBar={
														<ScopeBar
															resolvedScope={git.fileBrowserResolvedScope}
															scopeMode={git.fileBrowserScopeMode}
															homeGitSummary={homeGitSummary}
															taskTitle={null}
															taskBranch={null}
															taskBaseRef={null}
															behindBaseCount={null}
															isDetachedHead={
																homeGitSummary?.currentBranch === null && homeGitSummary !== null
															}
															onSwitchToHome={git.fileBrowserSwitchToHome}
															onReturnToContextual={git.fileBrowserReturnToContextual}
															branchPillSlot={
																<BranchSelectorPopover
																	isOpen={git.fileBrowserBranchActions.isBranchPopoverOpen}
																	onOpenChange={git.fileBrowserBranchActions.setBranchPopoverOpen}
																	branches={git.fileBrowserBranchActions.branches}
																	currentBranch={git.fileBrowserBranchActions.currentBranch}
																	worktreeBranches={git.fileBrowserBranchActions.worktreeBranches}
																	onSelectBranchView={
																		git.fileBrowserBranchActions.handleSelectBranchView
																	}
																	onCheckoutBranch={git.fileBrowserBranchActions.handleCheckoutBranch}
																	onCompareWithBranch={(branch) =>
																		git.openGitCompare({ targetRef: branch })
																	}
																	onMergeBranch={git.fileBrowserBranchActions.handleMergeBranch}
																	onCreateBranch={git.fileBrowserBranchActions.handleCreateBranchFrom}
																	onDeleteBranch={git.fileBrowserBranchActions.handleDeleteBranch}
																	onPull={
																		git.fileBrowserResolvedScope?.type !== "branch_view"
																			? (branch) => {
																					void git.runGitAction("pull", null, branch);
																				}
																			: undefined
																	}
																	onPush={
																		git.fileBrowserResolvedScope?.type !== "branch_view"
																			? (branch) => {
																					void git.runGitAction("push", null, branch);
																				}
																			: undefined
																	}
																	pinnedBranches={project.pinnedBranches}
																	onTogglePinBranch={project.handleTogglePinBranch}
																	disableContextMenu
																	trigger={
																		<BranchPillTrigger
																			label={
																				git.fileBrowserResolvedScope?.type === "branch_view"
																					? git.fileBrowserResolvedScope.ref
																					: (homeGitSummary?.currentBranch ?? "unknown")
																			}
																			aheadCount={
																				git.fileBrowserResolvedScope?.type === "branch_view"
																					? undefined
																					: homeGitSummary?.aheadCount
																			}
																			behindCount={
																				git.fileBrowserResolvedScope?.type === "branch_view"
																					? undefined
																					: homeGitSummary?.behindCount
																			}
																		/>
																	}
																/>
															}
															onCheckoutBrowsingBranch={
																git.fileBrowserResolvedScope?.type === "branch_view"
																	? () =>
																			git.fileBrowserBranchActions.handleCheckoutBranch(
																				git.fileBrowserResolvedScope?.type === "branch_view"
																					? git.fileBrowserResolvedScope.ref
																					: "",
																			)
																	: undefined
															}
														/>
													}
													fileBrowserData={git.homeFileBrowserData}
													rootPath={project.workspacePath}
													pendingFileNavigation={git.pendingFileNavigation}
													onFileNavigationConsumed={git.clearPendingFileNavigation}
												/>
											) : (
												<QuarterdeckBoard
													data={board}
													taskSessions={sessions}
													onCardSelect={interactions.handleCardSelect}
													onCreateTask={handleOpenCreateTask}
													onStartAllTasks={interactions.handleStartAllBacklogTasksFromBoard}
													onClearTrash={interactions.handleOpenClearTrash}
													editingTaskId={editingTaskId}
													inlineTaskEditor={inlineTaskEditor}
													onEditTask={handleOpenEditTask}
													dependencies={board.dependencies}
													onCreateDependency={interactions.handleCreateDependency}
													onDeleteDependency={interactions.handleDeleteDependency}
													onRequestProgrammaticCardMoveReady={interactions.handleProgrammaticCardMoveReady}
													onDragEnd={interactions.handleDragEnd}
												/>
											)}
										</div>
										{terminal.showHomeBottomTerminal ? (
											<ResizableBottomPane
												minHeight={200}
												initialHeight={terminal.homeTerminalPaneHeight}
												onHeightChange={terminal.setHomeTerminalPaneHeight}
												onCollapse={terminal.collapseHomeTerminal}
											>
												<div
													style={{
														display: "flex",
														flex: "1 1 0",
														minWidth: 0,
														paddingLeft: 12,
														paddingRight: 12,
													}}
												>
													<AgentTerminalPanel
														key={`home-shell-${terminal.homeTerminalTaskId}`}
														taskId={terminal.homeTerminalTaskId}
														workspaceId={project.currentProjectId}
														summary={terminal.homeTerminalSummary}
														onSummary={upsertSession}
														showSessionToolbar={false}
														autoFocus
														onClose={terminal.closeHomeTerminal}
														minimalHeaderTitle="Terminal"
														minimalHeaderSubtitle={terminal.homeTerminalSubtitle}
														panelBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
														terminalBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
														cursorColor={TERMINAL_THEME_COLORS.textPrimary}
														onConnectionReady={terminal.markTerminalConnectionReady}
														agentCommand={project.agentCommand}
														onSendAgentCommand={terminal.handleSendAgentCommandToHomeTerminal}
														isExpanded={terminal.isHomeTerminalExpanded}
														onToggleExpand={terminal.handleToggleExpandHomeTerminal}
														onRestart={terminal.handleRestartHomeTerminal}
														onExit={terminal.handleShellExit}
													/>
												</div>
											</ResizableBottomPane>
										) : null}
									</div>
								)}
							</div>
						</div>
					)}
					<DebugShelf />
					<RuntimeSettingsDialog
						open={dialog.isSettingsOpen}
						workspaceId={project.settingsWorkspaceId}
						initialConfig={project.settingsRuntimeProjectConfig}
						initialSection={dialog.settingsInitialSection}
						onOpenChange={(nextOpen) => {
							dialog.setIsSettingsOpen(nextOpen);
							if (!nextOpen) dialog.setSettingsInitialSection(null);
						}}
						onSaved={() => {
							project.refreshRuntimeProjectConfig();
							project.refreshSettingsRuntimeProjectConfig();
						}}
					/>
					<PromptShortcutEditorDialog
						open={dialog.promptShortcutEditorOpen}
						onOpenChange={dialog.setPromptShortcutEditorOpen}
						shortcuts={project.runtimeProjectConfig?.promptShortcuts ?? []}
						hiddenDefaultPromptShortcuts={project.runtimeProjectConfig?.hiddenDefaultPromptShortcuts ?? []}
						onSave={savePromptShortcuts}
					/>
					<TaskCreateDialog
						open={isInlineTaskCreateOpen}
						onOpenChange={dialog.handleCreateDialogOpenChange}
						prompt={newTaskPrompt}
						onPromptChange={setNewTaskPrompt}
						images={newTaskImages}
						onImagesChange={setNewTaskImages}
						onCreate={handleCreateTask}
						onCreateAndStart={interactions.handleCreateAndStartTask}
						onCreateStartAndOpen={interactions.handleCreateStartAndOpenTask}
						onCreateMultiple={handleCreateTasks}
						onCreateAndStartMultiple={interactions.handleCreateAndStartTasks}
						startInPlanMode={newTaskStartInPlanMode}
						onStartInPlanModeChange={setNewTaskStartInPlanMode}
						startInPlanModeDisabled={isNewTaskStartInPlanModeDisabled}
						autoReviewEnabled={newTaskAutoReviewEnabled}
						onAutoReviewEnabledChange={setNewTaskAutoReviewEnabled}
						useWorktree={newTaskUseWorktree}
						onUseWorktreeChange={setNewTaskUseWorktree}
						currentBranch={project.workspaceGit?.currentBranch ?? null}
						createFeatureBranch={createFeatureBranch}
						onCreateFeatureBranchChange={setCreateFeatureBranch}
						branchName={branchName}
						onBranchNameEdit={handleBranchNameEdit}
						onGenerateBranchName={generateBranchNameFromPrompt}
						isGeneratingBranchName={isGeneratingBranchName}
						isLlmGenerationDisabled={project.isLlmGenerationDisabled}
						workspaceId={project.currentProjectId}
						branchRef={newTaskBranchRef}
						branchOptions={createTaskBranchOptions}
						onBranchRefChange={setNewTaskBranchRef}
						defaultBaseRef={project.configDefaultBaseRef}
						onSetDefaultBaseRef={project.handleSetDefaultBaseRef}
					/>
					<ClearTrashDialog
						open={dialog.isClearTrashDialogOpen}
						taskCount={interactions.trashTaskCount}
						onCancel={() => dialog.setIsClearTrashDialogOpen(false)}
						onConfirm={interactions.handleConfirmClearTrash}
					/>
					<HardDeleteTaskDialog
						open={interactions.hardDeleteDialogState.open}
						taskTitle={interactions.hardDeleteDialogState.taskTitle}
						onCancel={interactions.handleCancelHardDelete}
						onConfirm={interactions.handleConfirmHardDelete}
					/>
					<TaskTrashWarningDialog
						open={interactions.trashWarningState.open}
						warning={interactions.trashWarningState.warning}
						onCancel={interactions.handleCancelTrashWarning}
						onConfirm={interactions.handleConfirmTrashWarning}
					/>
					<CheckoutConfirmationDialog
						state={git.fileBrowserBranchActions.checkoutDialogState}
						onClose={git.fileBrowserBranchActions.closeCheckoutDialog}
						onConfirmCheckout={git.fileBrowserBranchActions.handleConfirmCheckout}
						onStashAndCheckout={git.fileBrowserBranchActions.handleStashAndCheckout}
						isStashingAndCheckingOut={git.fileBrowserBranchActions.isStashingAndCheckingOut}
					/>
					<CheckoutConfirmationDialog
						state={git.topbarBranchActions.checkoutDialogState}
						onClose={git.topbarBranchActions.closeCheckoutDialog}
						onConfirmCheckout={git.topbarBranchActions.handleConfirmCheckout}
						onSkipTaskConfirmationChange={project.handleSkipTaskCheckoutConfirmationChange}
						onStashAndCheckout={git.topbarBranchActions.handleStashAndCheckout}
						isStashingAndCheckingOut={git.topbarBranchActions.isStashingAndCheckingOut}
					/>
					<CreateBranchDialog
						state={git.fileBrowserBranchActions.createBranchDialogState}
						workspaceId={project.currentProjectId}
						onClose={git.fileBrowserBranchActions.closeCreateBranchDialog}
						onBranchCreated={git.fileBrowserBranchActions.handleBranchCreated}
					/>
					<CreateBranchDialog
						state={git.topbarBranchActions.createBranchDialogState}
						workspaceId={project.currentProjectId}
						onClose={git.topbarBranchActions.closeCreateBranchDialog}
						onBranchCreated={git.topbarBranchActions.handleBranchCreated}
					/>
					<DeleteBranchDialog
						open={git.fileBrowserBranchActions.deleteBranchDialogState.type === "open"}
						branchName={
							git.fileBrowserBranchActions.deleteBranchDialogState.type === "open"
								? git.fileBrowserBranchActions.deleteBranchDialogState.branchName
								: ""
						}
						onCancel={git.fileBrowserBranchActions.closeDeleteBranchDialog}
						onConfirm={git.fileBrowserBranchActions.handleConfirmDeleteBranch}
					/>
					<DeleteBranchDialog
						open={git.topbarBranchActions.deleteBranchDialogState.type === "open"}
						branchName={
							git.topbarBranchActions.deleteBranchDialogState.type === "open"
								? git.topbarBranchActions.deleteBranchDialogState.branchName
								: ""
						}
						onCancel={git.topbarBranchActions.closeDeleteBranchDialog}
						onConfirm={git.topbarBranchActions.handleConfirmDeleteBranch}
					/>
					<MergeBranchDialog
						open={git.fileBrowserBranchActions.mergeBranchDialogState.type === "open"}
						branchName={
							git.fileBrowserBranchActions.mergeBranchDialogState.type === "open"
								? git.fileBrowserBranchActions.mergeBranchDialogState.branchName
								: ""
						}
						currentBranch={git.fileBrowserBranchActions.currentBranch ?? "current branch"}
						onCancel={git.fileBrowserBranchActions.closeMergeBranchDialog}
						onConfirm={git.fileBrowserBranchActions.handleConfirmMergeBranch}
					/>
					<MergeBranchDialog
						open={git.topbarBranchActions.mergeBranchDialogState.type === "open"}
						branchName={
							git.topbarBranchActions.mergeBranchDialogState.type === "open"
								? git.topbarBranchActions.mergeBranchDialogState.branchName
								: ""
						}
						currentBranch={git.topbarBranchActions.currentBranch ?? "current branch"}
						onCancel={git.topbarBranchActions.closeMergeBranchDialog}
						onConfirm={git.topbarBranchActions.handleConfirmMergeBranch}
					/>
					<MigrateWorkingDirectoryDialog
						open={pendingMigrate !== null}
						direction={pendingMigrate?.direction ?? "isolate"}
						isMigrating={migratingTaskId !== null}
						onCancel={cancelMigrate}
						onConfirm={handleConfirmMigrate}
					/>
					<ProjectDialogs />
					<GitActionErrorDialog
						open={git.gitActionError !== null}
						title={git.gitActionErrorTitle}
						message={git.gitActionError?.message ?? ""}
						output={git.gitActionError?.output ?? null}
						onClose={git.clearGitActionError}
						onStashAndRetry={git.onStashAndRetry}
						isStashAndRetrying={git.isStashAndRetryingPull}
					/>
				</div>
			</LayoutCustomizationsProvider>
		</CardActionsProvider>
	);
}
