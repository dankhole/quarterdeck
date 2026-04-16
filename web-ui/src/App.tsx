// Main React composition root for the browser app.
// Keep this file focused on wiring top-level hooks and surfaces together, and
// push runtime-specific orchestration down into hooks and service modules.

import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import type { Dispatch, ReactElement, MouseEvent as ReactMouseEvent, ReactNode, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AppDialogs,
	ConnectedTopBar,
	HomeView,
	ProjectNavigationPanel,
	QuarterdeckAccessBlockedFallback,
	RuntimeDisconnectedFallback,
} from "@/components/app";
import { showAppToast } from "@/components/app-toaster";
import { GitHistoryView } from "@/components/git";
import { CommitPanel } from "@/components/git/panels";
import { CardDetailView, TaskInlineCreateCard } from "@/components/task";
import { DetailToolbar, TOOLBAR_WIDTH } from "@/components/terminal";
import { createInitialBoardData } from "@/data/board-data";
import { useAppHotkeys, useEscapeHandler, useNavbarState } from "@/hooks/app";
import {
	useBoardMetadataSync,
	useDisplaySummaryOnHover,
	usePromptShortcuts,
	useTaskBaseRefSync,
	useTaskTitleSync,
	useTaskWorkingDirectorySync,
	useTitleActions,
} from "@/hooks/board";
import {
	useAudibleNotifications,
	useFocusedTaskNotification,
	useReviewReadyNotifications,
	useStreamErrorHandler,
} from "@/hooks/notifications";
import { useProjectSwitchCleanup, useProjectUiState } from "@/hooks/project";
import { useShortcutActions } from "@/hooks/settings";
import { useMigrateTaskDialog, useTerminalConfigSync } from "@/hooks/terminal";
import { BoardProvider, useBoardContext } from "@/providers/board-provider";
import { DialogProvider, useDialogContext } from "@/providers/dialog-provider";
import { GitProvider, useGitContext } from "@/providers/git-provider";
import { InteractionsProvider, useInteractionsContext } from "@/providers/interactions-provider";
import { ProjectProvider, useProjectContext } from "@/providers/project-provider";
import { TerminalProvider, useTerminalContext } from "@/providers/terminal-provider";
import { LayoutCustomizationsProvider, useLayoutResetEffect } from "@/resize/layout-customizations";
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
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import { cancelWarmup, initPool, warmup } from "@/terminal/terminal-pool";
import type { BoardData } from "@/types";
import { createIdleTaskSession } from "@/utils/app-utils";
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
	const boardRef = useRef(board);
	boardRef.current = board;
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;

	const handleProjectSwitchStart = useCallback(() => {
		setCanPersistWorkspaceState(false);
		setIsGitHistoryOpen(false);
		setPendingTaskStartAfterEditId(null);
		taskEditorResetRef.current();
	}, []);

	return (
		<ProjectProvider
			onProjectSwitchStart={handleProjectSwitchStart}
			boardRef={boardRef}
			sessionsRef={sessionsRef}
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
		isServedFromBoardCache: project.isServedFromBoardCache,
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
	});
	useTaskTitleSync({ latestTaskTitleUpdate: project.latestTaskTitleUpdate, setBoard });
	useTaskBaseRefSync({ latestTaskBaseRefUpdate: project.latestTaskBaseRefUpdate, setBoard });
	useTaskWorkingDirectorySync({
		latestTaskWorkingDirectoryUpdate: project.latestTaskWorkingDirectoryUpdate,
		setBoard,
	});
	useStreamErrorHandler({ streamError: project.streamError, isRuntimeDisconnected: project.isRuntimeDisconnected });

	useProjectSwitchCleanup({
		currentProjectId: project.currentProjectId,
		navigationCurrentProjectId: project.navigationCurrentProjectId,
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

	const handleCardSelectWithFocus = useCallback(
		(taskId: string) => {
			interactions.handleCardSelect(taskId);
			if (git.mainView === "terminal") {
				requestAnimationFrame(() => getTerminalController(taskId)?.focus?.());
			}
		},
		[interactions.handleCardSelect, git.mainView],
	);

	const handleCardDoubleClick = useCallback(
		(taskId: string) => {
			interactions.handleCardSelect(taskId);
			git.setMainView("terminal", { setSelectedTaskId });
			// Ensure the terminal gets focus even when the task is already selected
			// and the view is already "terminal" (no re-render to trigger autoFocus).
			requestAnimationFrame(() => getTerminalController(taskId)?.focus?.());
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
		<ConnectedTopBar
			onBack={selectedCard ? handleBack : undefined}
			runningShortcutLabel={runningShortcutLabel}
			handleSelectShortcutLabel={handleSelectShortcutLabel}
			handleRunShortcut={handleRunShortcut}
			handleCreateShortcut={handleCreateShortcut}
			activePromptShortcut={activePromptShortcut}
			isPromptShortcutRunning={isPromptShortcutRunning}
			runPromptShortcut={runPromptShortcut}
			selectPromptShortcutLabel={selectPromptShortcutLabel}
			navbarWorkspacePath={navbarWorkspacePath}
			navbarWorkspaceHint={navbarWorkspaceHint}
			navbarRuntimeHint={navbarRuntimeHint}
			shouldHideProjectDependentTopBarActions={shouldHideProjectDependentTopBarActions}
			shouldShowProjectLoadingState={shouldShowProjectLoadingState}
			homeGitSummary={homeGitSummary}
			selectedTaskWorkspaceSnapshot={selectedTaskWorkspaceSnapshot}
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
							onCardSelect={handleCardSelectWithFocus}
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
										onRebaseBranch={git.fileBrowserBranchActions.handleRebaseBranch}
										onRenameBranch={git.fileBrowserBranchActions.handleRenameBranch}
										onResetToRef={git.fileBrowserBranchActions.handleResetToRef}
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
						<HomeView
							topBar={topBar}
							shouldShowProjectLoadingState={shouldShowProjectLoadingState}
							editingTaskId={editingTaskId}
							inlineTaskEditor={inlineTaskEditor}
							handleOpenCreateTask={handleOpenCreateTask}
							handleOpenEditTask={handleOpenEditTask}
							homeGitSummary={homeGitSummary}
						/>
					)}
					<AppDialogs
						savePromptShortcuts={savePromptShortcuts}
						pendingMigrate={pendingMigrate}
						migratingTaskId={migratingTaskId}
						cancelMigrate={cancelMigrate}
						handleConfirmMigrate={handleConfirmMigrate}
					/>
				</div>
			</LayoutCustomizationsProvider>
		</CardActionsProvider>
	);
}
