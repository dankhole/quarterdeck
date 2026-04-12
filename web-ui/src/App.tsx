// Main React composition root for the browser app.
// Keep this file focused on wiring top-level hooks and surfaces together, and
// push runtime-specific orchestration down into hooks and service modules.

import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { FolderOpen } from "lucide-react";
import type { ReactElement, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { CardDetailView } from "@/components/card-detail-view";
import { ClearTrashDialog } from "@/components/clear-trash-dialog";
import { DebugDialog } from "@/components/debug-dialog";
import { DebugLogPanel } from "@/components/debug-log-panel";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { BranchPillTrigger, BranchSelectorPopover } from "@/components/detail-panels/branch-selector-popover";
import { CheckoutConfirmationDialog } from "@/components/detail-panels/checkout-confirmation-dialog";
import { DetailToolbar, TOOLBAR_WIDTH } from "@/components/detail-panels/detail-toolbar";
import { ScopeBar } from "@/components/detail-panels/scope-bar";
import { FilesView } from "@/components/files-view";
import { GitActionErrorDialog } from "@/components/git-action-error-dialog";
import { GitHistoryView } from "@/components/git-history-view";
import { GitInitDialog } from "@/components/git-init-dialog";
import { GitView } from "@/components/git-view";
import { HomeBranchStatus } from "@/components/home-branch-status";
import { MigrateWorkingDirectoryDialog } from "@/components/migrate-working-directory-dialog";
import { ProjectNavigationPanel } from "@/components/project-navigation-panel";
import { PromptShortcutEditorDialog } from "@/components/prompt-shortcut-editor-dialog";
import { QuarterdeckBoard } from "@/components/quarterdeck-board";
import { RuntimeSettingsDialog, type RuntimeSettingsSection } from "@/components/runtime-settings-dialog";
import { StartupOnboardingDialog } from "@/components/startup-onboarding-dialog";
import { TaskCreateDialog } from "@/components/task-create-dialog";
import { TaskInlineCreateCard } from "@/components/task-inline-create-card";
import { TaskTrashWarningDialog } from "@/components/task-trash-warning-dialog";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { createInitialBoardData } from "@/data/board-data";
import { createIdleTaskSession } from "@/hooks/app-utils";
import { QuarterdeckAccessBlockedFallback } from "@/hooks/quarterdeck-access-blocked-fallback";
import { RuntimeDisconnectedFallback } from "@/hooks/runtime-disconnected-fallback";
import { useAppHotkeys } from "@/hooks/use-app-hotkeys";
import { useAudibleNotifications } from "@/hooks/use-audible-notifications";
import { useBoardInteractions } from "@/hooks/use-board-interactions";
import { useBranchActions } from "@/hooks/use-branch-actions";
import { useDebugLogging } from "@/hooks/use-debug-logging";
import { useDebugTools } from "@/hooks/use-debug-tools";
import { useDetailTaskNavigation } from "@/hooks/use-detail-task-navigation";
import { useDisplaySummaryOnHover } from "@/hooks/use-display-summary";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { useFileBrowserData } from "@/hooks/use-file-browser-data";
import { useGitActions } from "@/hooks/use-git-actions";
import type { GitViewCompareNavigation } from "@/hooks/use-git-view-compare";
import { useHomeSidebarAgentPanel } from "@/hooks/use-home-sidebar-agent-panel";
import { type MigrateDirection, useMigrateWorkingDirectory } from "@/hooks/use-migrate-working-directory";
import { useOpenWorkspace } from "@/hooks/use-open-workspace";
import { parseRemovedProjectPathFromStreamError, useProjectNavigation } from "@/hooks/use-project-navigation";
import { useProjectUiState } from "@/hooks/use-project-ui-state";
import { usePromptShortcuts } from "@/hooks/use-prompt-shortcuts";
import { useQuarterdeckAccessGate } from "@/hooks/use-quarterdeck-access-gate";
import { useReviewReadyNotifications } from "@/hooks/use-review-ready-notifications";
import { useScopeContext } from "@/hooks/use-scope-context";
import { useShortcutActions } from "@/hooks/use-shortcut-actions";
import { useStartupOnboarding } from "@/hooks/use-startup-onboarding";
import { useTaskBranchOptions } from "@/hooks/use-task-branch-options";
import { useTaskEditor } from "@/hooks/use-task-editor";
import { useTaskSessions } from "@/hooks/use-task-sessions";
import { useTaskStartActions } from "@/hooks/use-task-start-actions";
import { getDetailTerminalTaskId, useTerminalPanels } from "@/hooks/use-terminal-panels";
import { useTitleActions } from "@/hooks/use-title-actions";
import { useWorkspaceSync } from "@/hooks/use-workspace-sync";
import { LayoutCustomizationsProvider, useLayoutResetEffect } from "@/resize/layout-customizations";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import { ResizeHandle } from "@/resize/resize-handle";
import { type MainViewId, useCardDetailLayout } from "@/resize/use-card-detail-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { getTaskAgentNavbarHint, isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import { saveRuntimeConfig } from "@/runtime/runtime-config-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useRuntimeProjectConfig } from "@/runtime/use-runtime-project-config";
import { useTerminalConnectionReady } from "@/runtime/use-terminal-connection-ready";
import { useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { saveWorkspaceState } from "@/runtime/workspace-state-query";
import {
	findCardSelection,
	reconcileTaskBranch,
	reconcileTaskWorkingDirectory,
	toggleTaskPinned,
} from "@/state/board-state";
import { CardActionsProvider, type ReactiveCardState, type StableCardActions } from "@/state/card-actions-context";
import {
	getTaskWorkspaceSnapshot,
	getWorkspacePath,
	replaceWorkspaceMetadata,
	resetWorkspaceMetadataStore,
	subscribeToAnyTaskMetadata,
	useHomeGitSummaryValue,
	useTaskWorkspaceInfoValue,
	useTaskWorkspaceSnapshotValue,
} from "@/stores/workspace-metadata-store";
import { setTerminalFontWeight, setTerminalWebGLRenderer } from "@/terminal/persistent-terminal-manager";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardData } from "@/types";
import { useWindowEvent } from "@/utils/react-use";
import { isApprovalState } from "@/utils/session-status";

/** Noop for useBranchActions selectBranchView — the topbar pill uses checkout as its primary action. */
const topbarBranchViewNoop = (_ref: string) => {};

/**
 * Bridge component that connects `useCardDetailLayout`'s reset callback to the
 * `LayoutCustomizationsProvider`. Must be rendered *inside* the provider tree so
 * `useLayoutResetEffect` can observe the `layoutResetNonce`.
 */
function LayoutResetBridge({ resetToDefaults }: { resetToDefaults: () => void }): null {
	useLayoutResetEffect(resetToDefaults);
	return null;
}

export default function App(): ReactElement {
	const [board, setBoard] = useState<BoardData>(() => createInitialBoardData());
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [canPersistWorkspaceState, setCanPersistWorkspaceState] = useState(false);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<RuntimeSettingsSection | null>(null);
	const [homeSidebarSection, setHomeSidebarSection] = useState<"projects" | "agent">("projects");
	const [isClearTrashDialogOpen, setIsClearTrashDialogOpen] = useState(false);
	const [isGitHistoryOpen, setIsGitHistoryOpen] = useState(false);
	const [pendingCompareNavigation, setPendingCompareNavigation] = useState<GitViewCompareNavigation | null>(null);
	const [pendingTaskStartAfterEditId, setPendingTaskStartAfterEditId] = useState<string | null>(null);
	const taskEditorResetRef = useRef<() => void>(() => {});
	const boardRef = useRef(board);
	boardRef.current = board;
	const findCardStable = useCallback(
		(cardId: string) => findCardSelection(boardRef.current, cardId)?.card ?? null,
		[],
	);
	const lastStreamErrorRef = useRef<string | null>(null);
	const handleProjectSwitchStart = useCallback(() => {
		setCanPersistWorkspaceState(false);
		setIsGitHistoryOpen(false);
		setPendingTaskStartAfterEditId(null);
		taskEditorResetRef.current();
	}, []);
	const {
		currentProjectId,
		projects,
		workspaceState: streamedWorkspaceState,
		workspaceMetadata,
		notificationSessions,
		notificationWorkspaceIds,
		latestTaskReadyForReview,
		latestTaskTitleUpdate,
		debugLoggingEnabled,
		debugLogEntries,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
		navigationCurrentProjectId,
		removingProjectId,
		hasNoProjects,
		isProjectSwitching,
		handleSelectProject,
		handleAddProject,
		handleConfirmInitializeGitProject,
		handleCancelInitializeGitProject,
		handleRemoveProject,
		handleReorderProjects,
		pendingGitInitializationPath,
		isInitializingGitProject,
		resetProjectNavigationState,
	} = useProjectNavigation({
		onProjectSwitchStart: handleProjectSwitchStart,
	});
	const { selectedTaskId, selectedCard, setSelectedTaskId } = useDetailTaskNavigation({
		board,
		currentProjectId,
		isBoardHydrated: hasReceivedSnapshot,
	});
	const isDocumentVisible = useDocumentVisibility();
	const isInitialRuntimeLoad =
		!hasReceivedSnapshot && currentProjectId === null && projects.length === 0 && !streamError;
	const isAwaitingWorkspaceSnapshot = currentProjectId !== null && streamedWorkspaceState === null;
	const {
		config: runtimeProjectConfig,
		isLoading: isRuntimeProjectConfigLoading,
		refresh: refreshRuntimeProjectConfig,
	} = useRuntimeProjectConfig(currentProjectId);
	const { isBlocked: isQuarterdeckAccessBlocked } = useQuarterdeckAccessGate({
		workspaceId: currentProjectId,
	});
	const isTaskAgentReady = isTaskAgentSetupSatisfied(runtimeProjectConfig);
	const settingsWorkspaceId = navigationCurrentProjectId ?? currentProjectId;
	const { config: settingsRuntimeProjectConfig, refresh: refreshSettingsRuntimeProjectConfig } =
		useRuntimeProjectConfig(settingsWorkspaceId);
	const {
		isStartupOnboardingDialogOpen,
		handleOpenStartupOnboardingDialog,
		handleCloseStartupOnboardingDialog,
		handleSelectOnboardingAgent,
	} = useStartupOnboarding({
		currentProjectId,
		runtimeProjectConfig,
		isRuntimeProjectConfigLoading,
		isTaskAgentReady,
		refreshRuntimeProjectConfig,
		refreshSettingsRuntimeProjectConfig,
	});
	const {
		debugModeEnabled,
		isDebugDialogOpen,
		isResetAllStatePending,
		handleOpenDebugDialog,
		handleShowStartupOnboardingDialog,
		handleDebugDialogOpenChange,
		handleResetAllState,
	} = useDebugTools({
		runtimeProjectConfig,
		settingsRuntimeProjectConfig,
		onOpenStartupOnboardingDialog: handleOpenStartupOnboardingDialog,
	});
	const debugLogging = useDebugLogging({
		currentProjectId,
		debugLoggingEnabled,
		debugLogEntries,
	});
	const {
		markConnectionReady: markTerminalConnectionReady,
		prepareWaitForConnection: prepareWaitForTerminalConnectionReady,
	} = useTerminalConnectionReady();
	const llmConfigured = runtimeProjectConfig?.llmConfigured ?? false;
	const isLlmGenerationDisabled = !llmConfigured;
	const handleRequestDisplaySummary = useDisplaySummaryOnHover(
		currentProjectId,
		runtimeProjectConfig?.autoGenerateSummary ?? CONFIG_DEFAULTS.autoGenerateSummary,
		runtimeProjectConfig?.summaryStaleAfterSeconds ?? CONFIG_DEFAULTS.summaryStaleAfterSeconds,
		llmConfigured,
	);
	const showTrashWorktreeNotice =
		runtimeProjectConfig?.showTrashWorktreeNotice ?? CONFIG_DEFAULTS.showTrashWorktreeNotice;
	const unmergedChangesIndicatorEnabled =
		runtimeProjectConfig?.unmergedChangesIndicatorEnabled ?? CONFIG_DEFAULTS.unmergedChangesIndicatorEnabled;
	const behindBaseIndicatorEnabled =
		runtimeProjectConfig?.behindBaseIndicatorEnabled ?? CONFIG_DEFAULTS.behindBaseIndicatorEnabled;
	const saveTrashWorktreeNoticeDismissed = useCallback(() => {
		void saveRuntimeConfig(currentProjectId, { showTrashWorktreeNotice: false }).then(() => {
			refreshRuntimeProjectConfig();
		});
	}, [currentProjectId, refreshRuntimeProjectConfig]);
	const shortcuts = runtimeProjectConfig?.shortcuts ?? [];
	const selectedShortcutLabel = useMemo(() => {
		if (shortcuts.length === 0) {
			return null;
		}
		const configured = runtimeProjectConfig?.selectedShortcutLabel ?? null;
		if (configured && shortcuts.some((shortcut) => shortcut.label === configured)) {
			return configured;
		}
		return shortcuts[0]?.label ?? null;
	}, [runtimeProjectConfig?.selectedShortcutLabel, shortcuts]);
	const {
		upsertSession,
		ensureTaskWorkspace,
		startTaskSession,
		stopTaskSession,
		sendTaskSessionInput,
		cleanupTaskWorkspace,
		fetchTaskWorkspaceInfo,
	} = useTaskSessions({
		currentProjectId,
		setSessions,
		onWorkingDirectoryResolved: (taskId, workingDirectory) => {
			setBoard((current) => {
				const result = reconcileTaskWorkingDirectory(current, taskId, workingDirectory, workspacePath);
				return result.updated ? result.board : current;
			});
		},
	});

	// Notify the runtime which task is focused so it can prioritize git polling.
	useEffect(() => {
		if (!currentProjectId || selectedTaskId === null) {
			return;
		}
		getRuntimeTrpcClient(currentProjectId)
			.workspace.setFocusedTask.mutate({ taskId: selectedTaskId })
			.catch(() => {
				// Fire-and-forget — polling priority is non-critical.
			});
	}, [currentProjectId, selectedTaskId]);

	// Reactive subscriptions — re-render when the metadata store updates for the selected task.
	const selectedTaskWorkspaceInfo = useTaskWorkspaceInfoValue(selectedCard?.card.id, selectedCard?.card.baseRef);
	const selectedTaskWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(selectedCard?.card.id);
	const homeGitSummary = useHomeGitSummaryValue();

	const {
		scopeMode: homeScopeMode,
		resolvedScope: homeResolvedScope,
		switchToHome: homeSwitchToHome,
		returnToContextual: homeReturnToContextual,
		selectBranchView: homeSelectBranchView,
	} = useScopeContext({
		selectedTaskId: null,
		selectedCard: null,
		currentProjectId,
	});

	const skipTaskCheckoutConfirmation = runtimeProjectConfig?.skipTaskCheckoutConfirmation ?? false;
	const skipHomeCheckoutConfirmation = runtimeProjectConfig?.skipHomeCheckoutConfirmation ?? false;

	const handleSkipTaskCheckoutConfirmationChange = useCallback(
		(skip: boolean) => {
			if (!currentProjectId) return;
			void saveRuntimeConfig(currentProjectId, { skipTaskCheckoutConfirmation: skip }).then(() => {
				refreshRuntimeProjectConfig();
			});
		},
		[currentProjectId, refreshRuntimeProjectConfig],
	);

	const homeBranchActions = useBranchActions({
		workspaceId: currentProjectId,
		board,
		selectBranchView: homeSelectBranchView,
		homeGitSummary,
		skipHomeCheckoutConfirmation,
		skipTaskCheckoutConfirmation,
		onCheckoutSuccess: homeReturnToContextual,
	});

	// Top-bar branch pill — separate hook instance so its popover/dialog state is independent.
	// Uses checkout as the primary click action (no separate browse), adapting scope based on
	// whether a task is selected. No onCheckoutSuccess — the topbar is context-free, there's
	// no view-mode to reset after checkout.
	const topbarBranchActions = useBranchActions({
		workspaceId: currentProjectId,
		board,
		selectBranchView: topbarBranchViewNoop,
		homeGitSummary,
		taskBranch: selectedCard ? (selectedTaskWorkspaceInfo?.branch ?? selectedCard.card.branch ?? null) : undefined,
		taskChangedFiles: selectedCard ? (selectedTaskWorkspaceSnapshot?.changedFiles ?? 0) : undefined,
		taskId: selectedCard?.card.id ?? null,
		baseRef: selectedCard?.card.baseRef ?? null,
		skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation,
	});

	const topbarBranchLabel = useMemo(() => {
		if (selectedCard) {
			return (
				selectedTaskWorkspaceInfo?.branch ??
				selectedCard.card.branch ??
				selectedTaskWorkspaceInfo?.headCommit?.substring(0, 7) ??
				null
			);
		}
		return homeGitSummary?.currentBranch ?? null;
	}, [selectedCard, selectedTaskWorkspaceInfo, homeGitSummary]);

	// Home-scope file browser data + tree state
	const homeFileBrowserData = useFileBrowserData({
		workspaceId: currentProjectId,
		taskId: homeResolvedScope?.type === "task" ? homeResolvedScope.taskId : null,
		baseRef: homeResolvedScope?.type === "task" ? homeResolvedScope.baseRef : undefined,
		ref: homeResolvedScope?.type === "branch_view" ? homeResolvedScope.ref : undefined,
	});

	const {
		workspacePath,
		workspaceGit,
		workspaceRevision,
		setWorkspaceRevision,
		workspaceHydrationNonce,
		isWorkspaceStateRefreshing,
		isWorkspaceMetadataPending,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	} = useWorkspaceSync({
		currentProjectId,
		streamedWorkspaceState,
		hasNoProjects,
		hasReceivedSnapshot,
		isDocumentVisible,
		setBoard,
		setSessions,
		setCanPersistWorkspaceState,
	});

	// Ref so hooks declared before useWorkspaceSync can call refreshWorkspaceState.
	const refreshWorkspaceStateRef = useRef<(() => Promise<void>) | null>(null);
	refreshWorkspaceStateRef.current = refreshWorkspaceState;

	useEffect(() => {
		replaceWorkspaceMetadata(workspaceMetadata);
	}, [workspaceMetadata]);

	// Self-heal card.workingDirectory and card.branch when the metadata monitor
	// reports values different from what the card has persisted. This catches
	// drift after migration, manual worktree changes, or any server-side CWD
	// resolution that the UI missed.
	useEffect(() => {
		return subscribeToAnyTaskMetadata((taskId) => {
			const snapshot = getTaskWorkspaceSnapshot(taskId);
			if (!snapshot?.path) {
				return;
			}
			setBoard((currentBoard) => {
				const wdResult = reconcileTaskWorkingDirectory(currentBoard, taskId, snapshot.path, getWorkspacePath());
				const branchResult = reconcileTaskBranch(wdResult.board, taskId, snapshot.branch);
				const updated = wdResult.updated || branchResult.updated;
				return updated ? branchResult.board : currentBoard;
			});
		});
	}, [setBoard]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceMetadataStore();
	}, [isProjectSwitching]);

	const {
		displayedProjects,
		navigationProjectPath,
		shouldShowProjectLoadingState,
		isProjectListLoading,
		shouldUseNavigationPath,
	} = useProjectUiState({
		board,
		canPersistWorkspaceState,
		currentProjectId,
		projects,
		navigationCurrentProjectId,
		selectedTaskId,
		streamError,
		isProjectSwitching,
		isInitialRuntimeLoad,
		isAwaitingWorkspaceSnapshot,
		isWorkspaceMetadataPending,
		hasReceivedSnapshot,
	});

	useReviewReadyNotifications({
		activeWorkspaceId: navigationCurrentProjectId,
		latestTaskReadyForReview,
		workspacePath,
	});

	// Known limitation: notification settings are read from the currently viewed project's config,
	// so toggling notifications off in one project silences all cross-workspace notifications.
	// Per-workspace notification settings are out of scope for now.
	const audibleNotificationsEnabled =
		runtimeProjectConfig?.audibleNotificationsEnabled ?? CONFIG_DEFAULTS.audibleNotificationsEnabled;
	const audibleNotificationVolume =
		runtimeProjectConfig?.audibleNotificationVolume ?? CONFIG_DEFAULTS.audibleNotificationVolume;
	const audibleNotificationEvents =
		runtimeProjectConfig?.audibleNotificationEvents ?? CONFIG_DEFAULTS.audibleNotificationEvents;
	const audibleNotificationsOnlyWhenHidden =
		runtimeProjectConfig?.audibleNotificationsOnlyWhenHidden ?? CONFIG_DEFAULTS.audibleNotificationsOnlyWhenHidden;

	const trashTaskIdSet = useMemo(() => {
		const trashColumn = board.columns.find((col) => col.id === "trash");
		return trashColumn ? new Set(trashColumn.cards.map((c) => c.id)) : new Set<string>();
	}, [board.columns]);

	useAudibleNotifications({
		notificationSessions,
		audibleNotificationsEnabled,
		audibleNotificationVolume,
		audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden,
		suppressedTaskIds: trashTaskIdSet,
	});

	const terminalFontWeight = runtimeProjectConfig?.terminalFontWeight ?? CONFIG_DEFAULTS.terminalFontWeight;
	useEffect(() => {
		setTerminalFontWeight(terminalFontWeight);
	}, [terminalFontWeight]);

	const terminalWebGLRenderer = runtimeProjectConfig?.terminalWebGLRenderer ?? CONFIG_DEFAULTS.terminalWebGLRenderer;
	useEffect(() => {
		setTerminalWebGLRenderer(terminalWebGLRenderer);
	}, [terminalWebGLRenderer]);

	// Apply task title updates received via WebSocket. Auto-generated titles
	// are only applied when the card title is still null (not yet set by the user).
	useEffect(() => {
		if (!latestTaskTitleUpdate) {
			return;
		}
		const { taskId, title, autoGenerated } = latestTaskTitleUpdate;
		setBoard((current) => {
			for (const column of current.columns) {
				const cardIndex = column.cards.findIndex((c) => c.id === taskId);
				if (cardIndex === -1) {
					continue;
				}
				const card = column.cards[cardIndex]!;
				if (card.title === title) {
					return current;
				}
				if (autoGenerated && card.title !== null) {
					return current;
				}
				const updatedCards = [...column.cards];
				updatedCards[cardIndex] = { ...card, title };
				return {
					...current,
					columns: current.columns.map((col) => (col.id === column.id ? { ...col, cards: updatedCards } : col)),
				};
			}
			return current;
		});
	}, [latestTaskTitleUpdate, setBoard]);

	const { createTaskBranchOptions, defaultTaskBranchRef } = useTaskBranchOptions({ workspaceGit });
	const queueTaskStartAfterEdit = useCallback((taskId: string) => {
		setPendingTaskStartAfterEditId(taskId);
	}, []);

	const {
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
		handleCancelCreateTask,
		handleOpenEditTask,
		handleCancelEditTask,
		handleSaveEditedTask,
		handleSaveAndStartEditedTask,
		handleCreateTask,
		handleCreateTasks,
		resetTaskEditorState,
	} = useTaskEditor({
		board,
		setBoard,
		currentProjectId,
		createTaskBranchOptions,
		defaultTaskBranchRef,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});

	useEffect(() => {
		taskEditorResetRef.current = resetTaskEditorState;
	}, [resetTaskEditorState]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceSyncState();
	}, [isProjectSwitching, resetWorkspaceSyncState]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetTaskEditorState();
	}, [isProjectSwitching, resetTaskEditorState]);

	const {
		runningGitAction,
		isDiscardingHomeWorkingChanges,
		gitActionError,
		gitActionErrorTitle,
		clearGitActionError,
		gitHistory,
		runGitAction,
		switchHomeBranch,
		discardHomeWorkingChanges,
		resetGitActionState,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
	} = useGitActions({
		currentProjectId,
		board,
		selectedCard,
		runtimeProjectConfig,
		sendTaskSessionInput,
		fetchTaskWorkspaceInfo,
		isGitHistoryOpen,
		refreshWorkspaceState,
	});
	const agentCommand = runtimeProjectConfig?.effectiveCommand ?? null;
	const {
		homeTerminalTaskId,
		isHomeTerminalOpen,
		isHomeTerminalStarting,
		homeTerminalPaneHeight,
		isDetailTerminalOpen,
		detailTerminalTaskId,
		isDetailTerminalStarting,
		detailTerminalPaneHeight,
		isHomeTerminalExpanded,
		isDetailTerminalExpanded,
		setHomeTerminalPaneHeight,
		setDetailTerminalPaneHeight,
		handleToggleExpandHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleDetailTerminal,
		handleSendAgentCommandToHomeTerminal,
		handleSendAgentCommandToDetailTerminal,
		handleRestartHomeTerminal,
		handleRestartDetailTerminal,
		prepareTerminalForShortcut,
		resetBottomTerminalLayoutCustomizations,
		collapseHomeTerminal,
		collapseDetailTerminal,
		closeHomeTerminal,
		closeDetailTerminal,
		resetTerminalPanelsState,
		handleShellExit,
	} = useTerminalPanels({
		currentProjectId,
		selectedCard,
		workspaceGit,
		agentCommand,
		shellAutoRestartEnabled: runtimeProjectConfig?.shellAutoRestartEnabled ?? CONFIG_DEFAULTS.shellAutoRestartEnabled,
		findCard: findCardStable,
		upsertSession,
		sendTaskSessionInput,
	});
	const homeTerminalSummary = sessions[homeTerminalTaskId] ?? null;
	const homeSidebarAgentPanel = useHomeSidebarAgentPanel({
		currentProjectId,
		hasNoProjects,
		runtimeProjectConfig,
		taskSessions: sessions,
		workspaceGit,
	});
	const { runningShortcutLabel, handleSelectShortcutLabel, handleRunShortcut, handleCreateShortcut } =
		useShortcutActions({
			currentProjectId,
			selectedShortcutLabel: runtimeProjectConfig?.selectedShortcutLabel,
			shortcuts,
			refreshRuntimeProjectConfig,
			prepareTerminalForShortcut,
			prepareWaitForTerminalConnectionReady,
			sendTaskSessionInput,
		});
	const {
		activeShortcut: activePromptShortcut,
		isRunning: isPromptShortcutRunning,
		runPromptShortcut,
		selectShortcutLabel: selectPromptShortcutLabel,
		savePromptShortcuts,
	} = usePromptShortcuts({
		currentProjectId,
		promptShortcuts: runtimeProjectConfig?.promptShortcuts ?? [],
		refreshRuntimeConfig: refreshRuntimeProjectConfig,
		sendTaskSessionInput,
	});
	const [promptShortcutEditorOpen, setPromptShortcutEditorOpen] = useState(false);

	const persistWorkspaceStateAsync = useCallback(
		async (input: { workspaceId: string; payload: Parameters<typeof saveWorkspaceState>[1] }) =>
			await saveWorkspaceState(input.workspaceId, input.payload),
		[],
	);
	const serverMutationInFlightRef = useRef(false);
	const handleWorkspaceStateConflict = useCallback(() => {
		// Suppress the conflict toast when a server-side mutation (e.g. migration)
		// is in flight — the state change was triggered by the user and will sync.
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
		currentProjectId,
		workspaceRevision,
		hydrationNonce: workspaceHydrationNonce,
		canPersistWorkspaceState,
		isDocumentVisible,
		isWorkspaceStateRefreshing,
		persistWorkspaceState: persistWorkspaceStateAsync,
		refetchWorkspaceState: refreshWorkspaceState,
		onWorkspaceRevisionChange: setWorkspaceRevision,
		onWorkspaceStateConflict: handleWorkspaceStateConflict,
	});

	useEffect(() => {
		if (!streamError) {
			lastStreamErrorRef.current = null;
			return;
		}
		const removedPath = parseRemovedProjectPathFromStreamError(streamError);
		if (removedPath !== null) {
			showAppToast(
				{
					intent: "danger",
					icon: "warning-sign",
					message: removedPath
						? `Project no longer exists and was removed: ${removedPath}`
						: "Project no longer exists and was removed.",
					timeout: 6000,
				},
				`project-removed-${removedPath || "unknown"}`,
			);
			lastStreamErrorRef.current = null;
			return;
		}
		if (isRuntimeDisconnected) {
			lastStreamErrorRef.current = streamError;
			return;
		}
		if (lastStreamErrorRef.current !== streamError) {
			notifyError(streamError, { key: `error:${streamError}` });
		}
		lastStreamErrorRef.current = streamError;
	}, [isRuntimeDisconnected, streamError]);

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
	]);

	useEffect(() => {
		if (selectedCard) {
			return;
		}
		if (hasNoProjects || !currentProjectId) {
			if (isHomeTerminalOpen) {
				closeHomeTerminal();
			}
			return;
		}
	}, [closeHomeTerminal, currentProjectId, hasNoProjects, isHomeTerminalOpen, selectedCard]);
	const showHomeBottomTerminal = !selectedCard && !hasNoProjects && isHomeTerminalOpen;
	const homeTerminalSubtitle = useMemo(
		() => workspacePath ?? navigationProjectPath ?? null,
		[navigationProjectPath, workspacePath],
	);

	const handleBack = useCallback(() => {
		setSelectedTaskId(null);
		setIsGitHistoryOpen(false);
	}, []);

	const handleOpenSettings = useCallback((section?: RuntimeSettingsSection) => {
		setSettingsInitialSection(section ?? null);
		setIsSettingsOpen(true);
	}, []);
	const handleToggleGitHistory = useCallback(() => {
		if (hasNoProjects) {
			return;
		}
		setIsGitHistoryOpen((current) => !current);
	}, [hasNoProjects]);

	const {
		handleProgrammaticCardMoveReady,
		handleCreateDependency,
		handleDeleteDependency,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleDetailTaskDragEnd,
		handleCardSelect,
		handleMoveReviewCardToTrash,
		handleRestoreTaskFromTrash,
		handleHardDeleteTrashTask,
		handleRestartTaskSession,
		handleCancelAutomaticTaskAction,
		handleOpenClearTrash,
		handleConfirmClearTrash,
		moveToTrashLoadingById,
		trashTaskCount,
		trashWarningState,
		handleCancelTrashWarning,
		handleConfirmTrashWarning,
	} = useBoardInteractions({
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard,
		selectedTaskId,
		currentProjectId,
		setSelectedTaskId,
		setIsClearTrashDialogOpen,
		setIsGitHistoryOpen,
		stopTaskSession,
		cleanupTaskWorkspace,
		ensureTaskWorkspace,
		startTaskSession,
		fetchTaskWorkspaceInfo,
		sendTaskSessionInput,
		showTrashWorktreeNotice,
		saveTrashWorktreeNoticeDismissed,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
	});

	const {
		handleCreateAndStartTask,
		handleCreateAndStartTasks,
		handleCreateStartAndOpenTask,
		handleStartTaskFromBoard,
		handleStartAllBacklogTasksFromBoard,
	} = useTaskStartActions({
		board,
		handleCreateTask,
		handleCreateTasks,
		handleStartTask,
		handleStartAllBacklogTasks,
		setSelectedTaskId,
	});

	const { handleRegenerateTitleTask, handleUpdateTaskTitle } = useTitleActions({ currentProjectId });

	const handleToggleTaskPinned = useCallback(
		(taskId: string) => {
			setBoard((prev) => toggleTaskPinned(prev, taskId).board);
		},
		[setBoard],
	);

	const { migrate: migrateWorkingDirectory, migratingTaskId } = useMigrateWorkingDirectory(currentProjectId);
	const [pendingMigrate, setPendingMigrate] = useState<{
		taskId: string;
		direction: MigrateDirection;
	} | null>(null);
	const handleMigrateWorkingDirectory = useCallback((taskId: string, direction: "isolate" | "de-isolate") => {
		setPendingMigrate({ taskId, direction });
	}, []);
	const handleConfirmMigrate = useCallback(() => {
		if (pendingMigrate) {
			serverMutationInFlightRef.current = true;
			void migrateWorkingDirectory(pendingMigrate.taskId, pendingMigrate.direction).finally(() => {
				serverMutationInFlightRef.current = false;
				// Stop any open detail shell for this task so the next open
				// spawns in the new working directory.
				void stopTaskSession(getDetailTerminalTaskId(pendingMigrate.taskId));
				void refreshWorkspaceState();
			});
			setPendingMigrate(null);
		}
	}, [pendingMigrate, migrateWorkingDirectory, refreshWorkspaceState, stopTaskSession]);

	useAppHotkeys({
		selectedCard,
		isDetailTerminalOpen,
		isHomeTerminalOpen: showHomeBottomTerminal,
		canUseCreateTaskShortcut: !hasNoProjects && currentProjectId !== null,
		handleToggleDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleExpandHomeTerminal,
		handleOpenCreateTask,
		handleOpenSettings,
		handleToggleGitHistory,
		onStartAllTasks: handleStartAllBacklogTasksFromBoard,
		handleToggleDebugLogPanel: debugLogging.toggleDebugLogPanel,
	});

	useEffect(() => {
		if (!pendingTaskStartAfterEditId) {
			return;
		}
		const selection = findCardSelection(board, pendingTaskStartAfterEditId);
		if (!selection || selection.column.id !== "backlog") {
			return;
		}
		handleStartTaskFromBoard(pendingTaskStartAfterEditId);
		setPendingTaskStartAfterEditId(null);
	}, [board, handleStartTaskFromBoard, pendingTaskStartAfterEditId]);

	const detailSession = selectedCard
		? (sessions[selectedCard.card.id] ?? createIdleTaskSession(selectedCard.card.id))
		: null;
	const detailTerminalSummary = detailTerminalTaskId ? (sessions[detailTerminalTaskId] ?? null) : null;
	const detailTerminalSubtitle = selectedTaskWorkspaceInfo?.path ?? selectedTaskWorkspaceSnapshot?.path ?? null;

	// --- Sidebar layout ---

	const {
		mainView,
		sidebar,
		setMainView,
		toggleSidebar,
		sidebarPinned,
		toggleSidebarPinned,
		visualMainView,
		visualSidebar,
		sidePanelRatio,
		setSidePanelRatio,
		resetToDefaults: resetCardDetailLayoutToDefaults,
	} = useCardDetailLayout({
		selectedTaskId,
		isProjectSwitching,
	});

	const handleMainViewChange = useCallback(
		(view: MainViewId) => {
			setMainView(view, { setSelectedTaskId });
		},
		[setMainView, setSelectedTaskId],
	);

	/** Double-click a task in the sidebar to select it and jump to agent chat. */
	const handleCardDoubleClick = useCallback(
		(taskId: string) => {
			handleCardSelect(taskId);
			setMainView("terminal", { setSelectedTaskId });
		},
		[handleCardSelect, setMainView, setSelectedTaskId],
	);

	/** Navigate to the git view's Compare tab with pre-set branch parameters (#5). */
	const openGitCompare = useCallback(
		(navigation: GitViewCompareNavigation) => {
			setPendingCompareNavigation(navigation);
			setMainView("git", { setSelectedTaskId });
		},
		[setMainView, setSelectedTaskId],
	);
	const clearPendingCompareNavigation = useCallback(() => setPendingCompareNavigation(null), []);

	// Auto-switch to git main view when git history is toggled on (e.g. via Cmd+G)
	useEffect(() => {
		if (isGitHistoryOpen) {
			setMainView("git", { setSelectedTaskId });
		}
	}, [isGitHistoryOpen, setMainView, setSelectedTaskId]);

	// --- Home side panel resize ---
	const { startDrag: startHomeSidePanelResize } = useResizeDrag();
	const sidebarAreaRef = useRef<HTMLDivElement | null>(null);

	const handleHomeSidePanelSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = sidebarAreaRef.current;
			if (!container) return;
			const containerWidth = Math.max(container.offsetWidth - TOOLBAR_WIDTH, 1);
			const startX = event.clientX;
			const startRatio = sidePanelRatio;
			startHomeSidePanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaRatio = (pointerX - startX) / containerWidth;
					setSidePanelRatio(startRatio + deltaRatio);
				},
				onEnd: (pointerX) => {
					const deltaRatio = (pointerX - startX) / containerWidth;
					setSidePanelRatio(startRatio + deltaRatio);
				},
			});
		},
		[setSidePanelRatio, startHomeSidePanelResize, sidePanelRatio],
	);

	// --- Unified Escape handler ---
	const handleEscapeKeydown = useCallback(
		(event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			// Skip if inside a dialog
			if (event.target instanceof Element && event.target.closest("[role='dialog']")) return;

			// 1. Git history open → close it (home or task context)
			if (isGitHistoryOpen) {
				event.preventDefault();
				setIsGitHistoryOpen(false);
				return;
			}

			const isTyping =
				event.target instanceof HTMLElement &&
				(event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.isContentEditable);
			if (isTyping) return;

			// 2. Task selected → deselect
			if (selectedCard) {
				event.preventDefault();
				setSelectedTaskId(null);
				return;
			}
		},
		[isGitHistoryOpen, selectedCard],
	);
	useWindowEvent("keydown", handleEscapeKeydown);

	const runtimeHint = useMemo(() => {
		return getTaskAgentNavbarHint(runtimeProjectConfig, {
			shouldUseNavigationPath,
		});
	}, [runtimeProjectConfig, shouldUseNavigationPath]);

	const activeWorkspacePath = selectedCard
		? (selectedTaskWorkspaceInfo?.path ?? selectedTaskWorkspaceSnapshot?.path ?? workspacePath ?? undefined)
		: shouldUseNavigationPath
			? (navigationProjectPath ?? undefined)
			: (workspacePath ?? undefined);

	const activeWorkspaceHint = useMemo(() => {
		if (!selectedCard) {
			return undefined;
		}
		if (!selectedTaskWorkspaceInfo) {
			return undefined;
		}
		if (!selectedTaskWorkspaceInfo.exists) {
			return selectedCard.column.id === "trash" ? "Task workspace deleted" : "Task workspace not created yet";
		}
		return undefined;
	}, [selectedCard, selectedTaskWorkspaceInfo]);

	const navbarWorkspacePath = hasNoProjects ? undefined : activeWorkspacePath;
	const navbarWorkspaceHint = hasNoProjects ? undefined : activeWorkspaceHint;
	const navbarRuntimeHint = hasNoProjects ? undefined : runtimeHint;
	const shouldHideProjectDependentTopBarActions =
		!selectedCard && (isProjectSwitching || isAwaitingWorkspaceSnapshot || isWorkspaceMetadataPending);

	const {
		openTargetOptions,
		selectedOpenTargetId,
		onSelectOpenTarget,
		onOpenWorkspace,
		canOpenWorkspace,
		isOpeningWorkspace,
	} = useOpenWorkspace({
		currentProjectId,
		workspacePath: activeWorkspacePath,
	});
	const handleCreateDialogOpenChange = useCallback(
		(open: boolean) => {
			if (!open) {
				handleCancelCreateTask();
			}
		},
		[handleCancelCreateTask],
	);

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
			workspaceId={currentProjectId}
			branchRef={editTaskBranchRef}
			branchOptions={createTaskBranchOptions}
			onBranchRefChange={setEditTaskBranchRef}
			mode="edit"
			idPrefix={`inline-edit-task-${editingTaskId}`}
		/>
	) : undefined;

	const stableCardActions = useMemo<StableCardActions>(
		() => ({
			onStartTask: handleStartTaskFromBoard,
			onRestartSessionTask: handleRestartTaskSession,
			onMoveToTrashTask: handleMoveReviewCardToTrash,
			onRestoreFromTrashTask: handleRestoreTaskFromTrash,
			onHardDeleteTrashTask: handleHardDeleteTrashTask,
			onCancelAutomaticTaskAction: handleCancelAutomaticTaskAction,
			onRegenerateTitleTask: handleRegenerateTitleTask,
			onUpdateTaskTitle: handleUpdateTaskTitle,
			onTogglePinTask: handleToggleTaskPinned,
			onMigrateWorkingDirectory: handleMigrateWorkingDirectory,
			onRequestDisplaySummary: handleRequestDisplaySummary,
		}),
		[
			handleStartTaskFromBoard,
			handleRestartTaskSession,
			handleMoveReviewCardToTrash,
			handleRestoreTaskFromTrash,
			handleHardDeleteTrashTask,
			handleCancelAutomaticTaskAction,
			handleRegenerateTitleTask,
			handleUpdateTaskTitle,
			handleToggleTaskPinned,
			handleMigrateWorkingDirectory,
			handleRequestDisplaySummary,
		],
	);

	const reactiveCardState = useMemo<ReactiveCardState>(
		() => ({
			moveToTrashLoadingById: moveToTrashLoadingById ?? {},
			migratingTaskId: migratingTaskId ?? null,
			isLlmGenerationDisabled,
			showSummaryOnCards: runtimeProjectConfig?.showSummaryOnCards ?? CONFIG_DEFAULTS.showSummaryOnCards,
			uncommittedChangesOnCardsEnabled:
				runtimeProjectConfig?.uncommittedChangesOnCardsEnabled ?? CONFIG_DEFAULTS.uncommittedChangesOnCardsEnabled,
			showRunningTaskEmergencyActions:
				runtimeProjectConfig?.showRunningTaskEmergencyActions ?? CONFIG_DEFAULTS.showRunningTaskEmergencyActions,
		}),
		[
			moveToTrashLoadingById,
			migratingTaskId,
			isLlmGenerationDisabled,
			runtimeProjectConfig?.showSummaryOnCards,
			runtimeProjectConfig?.uncommittedChangesOnCardsEnabled,
			runtimeProjectConfig?.showRunningTaskEmergencyActions,
		],
	);

	// notificationSessions is seeded from the current project only on initial load;
	// cross-project entries arrive incrementally via task_notification messages after page load.
	// Exclude the current project — its approvals are already visible in the board.
	const projectsBadgeColor: "orange" | undefined = useMemo(
		() =>
			Object.entries(notificationSessions).some(
				([taskId, session]) => notificationWorkspaceIds[taskId] !== currentProjectId && isApprovalState(session),
			)
				? "orange"
				: undefined,
		[notificationSessions, notificationWorkspaceIds, currentProjectId],
	);

	if (isRuntimeDisconnected) {
		return <RuntimeDisconnectedFallback />;
	}
	if (isQuarterdeckAccessBlocked) {
		return <QuarterdeckAccessBlockedFallback />;
	}

	const homeSidePanelPercent = `${(sidePanelRatio * 100).toFixed(1)}%`;

	const topBar = (
		<TopBar
			onBack={selectedCard ? handleBack : undefined}
			workspacePath={navbarWorkspacePath}
			isWorkspacePathLoading={shouldShowProjectLoadingState}
			workspaceHint={navbarWorkspaceHint}
			runtimeHint={navbarRuntimeHint}
			selectedTaskId={selectedCard?.card.id ?? null}
			onToggleTerminal={
				hasNoProjects ? undefined : selectedCard ? handleToggleDetailTerminal : handleToggleHomeTerminal
			}
			isTerminalOpen={selectedCard ? isDetailTerminalOpen : showHomeBottomTerminal}
			isTerminalLoading={selectedCard ? isDetailTerminalStarting : isHomeTerminalStarting}
			onOpenSettings={handleOpenSettings}
			showDebugButton={debugModeEnabled}
			onOpenDebugDialog={debugModeEnabled ? handleOpenDebugDialog : undefined}
			shortcuts={shortcuts}
			selectedShortcutLabel={selectedShortcutLabel}
			onSelectShortcutLabel={handleSelectShortcutLabel}
			runningShortcutLabel={runningShortcutLabel}
			onRunShortcut={handleRunShortcut}
			onCreateFirstShortcut={currentProjectId ? handleCreateShortcut : undefined}
			promptShortcuts={runtimeProjectConfig?.promptShortcuts ?? []}
			activePromptShortcut={activePromptShortcut}
			onSelectPromptShortcutLabel={selectPromptShortcutLabel}
			isPromptShortcutRunning={isPromptShortcutRunning}
			onRunPromptShortcut={runPromptShortcut}
			onManagePromptShortcuts={() => setPromptShortcutEditorOpen(true)}
			openTargetOptions={openTargetOptions}
			selectedOpenTargetId={selectedOpenTargetId}
			onSelectOpenTarget={onSelectOpenTarget}
			onOpenWorkspace={onOpenWorkspace}
			canOpenWorkspace={canOpenWorkspace}
			isOpeningWorkspace={isOpeningWorkspace}
			hideProjectDependentActions={shouldHideProjectDependentTopBarActions}
			branchPillSlot={
				topbarBranchLabel ? (
					<BranchSelectorPopover
						isOpen={topbarBranchActions.isBranchPopoverOpen}
						onOpenChange={topbarBranchActions.setBranchPopoverOpen}
						branches={topbarBranchActions.branches}
						currentBranch={topbarBranchActions.currentBranch}
						worktreeBranches={topbarBranchActions.worktreeBranches}
						onSelectBranchView={topbarBranchActions.handleCheckoutBranch}
						onCheckoutBranch={topbarBranchActions.handleCheckoutBranch}
						trigger={<BranchPillTrigger label={topbarBranchLabel} />}
					/>
				) : undefined
			}
		/>
	);

	return (
		<CardActionsProvider stable={stableCardActions} reactive={reactiveCardState}>
			<LayoutCustomizationsProvider
				onResetBottomTerminalLayoutCustomizations={resetBottomTerminalLayoutCustomizations}
			>
				<LayoutResetBridge resetToDefaults={resetCardDetailLayoutToDefaults} />
				<div ref={sidebarAreaRef} className="flex h-[100svh] min-w-0 overflow-hidden">
					{/* Sidebar toolbar + side panel */}
					<>
						<DetailToolbar
							activeMainView={visualMainView}
							activeSidebar={visualSidebar}
							onMainViewChange={handleMainViewChange}
							onSidebarChange={toggleSidebar}
							sidebarPinned={sidebarPinned}
							onToggleSidebarPinned={toggleSidebarPinned}
							hasSelectedTask={selectedCard !== null}
							gitBadgeColor={
								selectedCard
									? (selectedTaskWorkspaceSnapshot?.changedFiles ?? 0) > 0
										? "red"
										: unmergedChangesIndicatorEnabled &&
												(selectedTaskWorkspaceSnapshot?.hasUnmergedChanges ?? false)
											? "blue"
											: undefined
									: (homeGitSummary?.changedFiles ?? 0) > 0
										? "red"
										: undefined
							}
							isBehindBase={
								behindBaseIndicatorEnabled && selectedCard
									? (selectedTaskWorkspaceSnapshot?.behindBaseCount ?? 0) > 0
									: false
							}
							projectsBadgeColor={projectsBadgeColor}
						/>

						{/* Sidebar panel content — depends on sidebar state */}
						{sidebar === "projects" || (sidebar !== null && !selectedCard) ? (
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
										currentProjectId={navigationCurrentProjectId}
										removingProjectId={removingProjectId}
										activeSection={homeSidebarSection}
										onActiveSectionChange={setHomeSidebarSection}
										canShowAgentSection={!hasNoProjects && Boolean(currentProjectId)}
										agentSectionContent={homeSidebarAgentPanel}
										onSelectProject={(projectId) => {
											void handleSelectProject(projectId);
										}}
										onRemoveProject={handleRemoveProject}
										onReorderProjects={handleReorderProjects}
										onAddProject={() => {
											void handleAddProject();
										}}
										notificationSessions={notificationSessions}
										notificationWorkspaceIds={notificationWorkspaceIds}
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

					{/* Main area — varies by selection state */}
					{selectedCard && detailSession ? (
						<CardDetailView
							selection={selectedCard}
							currentProjectId={currentProjectId}
							sessionSummary={detailSession}
							taskSessions={sessions}
							onSessionSummary={upsertSession}
							onCardSelect={handleCardSelect}
							onCardDoubleClick={handleCardDoubleClick}
							onTaskDragEnd={handleDetailTaskDragEnd}
							onCreateTask={handleOpenCreateTask}
							onStartAllTasks={handleStartAllBacklogTasksFromBoard}
							onClearTrash={handleOpenClearTrash}
							editingTaskId={editingTaskId}
							inlineTaskEditor={inlineTaskEditor}
							onEditTask={(task) => {
								handleOpenEditTask(task, { preserveDetailSelection: true });
							}}
							gitHistoryPanel={
								isGitHistoryOpen ? (
									<GitHistoryView workspaceId={currentProjectId} gitHistory={gitHistory} />
								) : undefined
							}
							isGitHistoryOpen={isGitHistoryOpen}
							onToggleGitHistory={handleToggleGitHistory}
							bottomTerminalOpen={isDetailTerminalOpen}
							bottomTerminalTaskId={detailTerminalTaskId}
							bottomTerminalSummary={detailTerminalSummary}
							bottomTerminalSubtitle={detailTerminalSubtitle}
							onBottomTerminalClose={closeDetailTerminal}
							onBottomTerminalCollapse={collapseDetailTerminal}
							bottomTerminalPaneHeight={detailTerminalPaneHeight}
							onBottomTerminalPaneHeightChange={setDetailTerminalPaneHeight}
							onBottomTerminalConnectionReady={markTerminalConnectionReady}
							bottomTerminalAgentCommand={agentCommand}
							onBottomTerminalSendAgentCommand={handleSendAgentCommandToDetailTerminal}
							isBottomTerminalExpanded={isDetailTerminalExpanded}
							onBottomTerminalToggleExpand={handleToggleExpandDetailTerminal}
							onBottomTerminalRestart={handleRestartDetailTerminal}
							onBottomTerminalExit={handleShellExit}
							mainView={mainView}
							sidebar={sidebar}
							topBar={topBar}
							sidePanelRatio={sidePanelRatio}
							setSidePanelRatio={setSidePanelRatio}
							board={board}
							skipTaskCheckoutConfirmation={skipTaskCheckoutConfirmation}
							skipHomeCheckoutConfirmation={skipHomeCheckoutConfirmation}
							onSkipTaskCheckoutConfirmationChange={handleSkipTaskCheckoutConfirmationChange}
							onDeselectTask={() => setSelectedTaskId(null)}
							pendingCompareNavigation={pendingCompareNavigation}
							onCompareNavigationConsumed={clearPendingCompareNavigation}
							onOpenGitCompare={openGitCompare}
							chatViewEnabled={
								runtimeProjectConfig?.terminalChatViewEnabled ?? CONFIG_DEFAULTS.terminalChatViewEnabled
							}
						/>
					) : (
						<div className="flex flex-col flex-1 min-w-0 overflow-hidden">
							{topBar}
							<div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
								{shouldShowProjectLoadingState ? (
									<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0">
										<Spinner size={30} />
									</div>
								) : hasNoProjects ? (
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
													void handleAddProject();
												}}
											>
												Add Project
											</Button>
										</div>
									</div>
								) : (
									<div className="flex flex-1 flex-col min-h-0 min-w-0">
										<div className="flex flex-1 min-h-0 min-w-0">
											{mainView === "git" ? (
												<GitView
													currentProjectId={currentProjectId}
													selectedCard={null}
													sessionSummary={null}
													homeGitSummary={homeGitSummary}
													board={board}
													pendingCompareNavigation={pendingCompareNavigation}
													onCompareNavigationConsumed={clearPendingCompareNavigation}
													branchStatusSlot={
														homeGitSummary ? (
															<HomeBranchStatus
																homeGitSummary={homeGitSummary}
																isGitHistoryOpen={isGitHistoryOpen}
																onToggleGitHistory={handleToggleGitHistory}
																runningGitAction={runningGitAction}
																onGitFetch={() => {
																	void runGitAction("fetch");
																}}
																onGitPull={() => {
																	void runGitAction("pull");
																}}
																onGitPush={() => {
																	void runGitAction("push");
																}}
															/>
														) : undefined
													}
													gitHistoryPanel={
														isGitHistoryOpen ? (
															<GitHistoryView
																workspaceId={currentProjectId}
																gitHistory={gitHistory}
																onCheckoutBranch={(branch) => {
																	void switchHomeBranch(branch);
																}}
																onDiscardWorkingChanges={() => {
																	void discardHomeWorkingChanges();
																}}
																isDiscardWorkingChangesPending={isDiscardingHomeWorkingChanges}
															/>
														) : undefined
													}
												/>
											) : mainView === "files" ? (
												<FilesView
													key={currentProjectId ?? "no-project"}
													scopeBar={
														<ScopeBar
															resolvedScope={homeResolvedScope}
															scopeMode={homeScopeMode}
															homeGitSummary={homeGitSummary}
															taskTitle={null}
															taskBranch={null}
															taskBaseRef={null}
															behindBaseCount={null}
															isDetachedHead={
																homeGitSummary?.currentBranch === null && homeGitSummary !== null
															}
															onSwitchToHome={homeSwitchToHome}
															onReturnToContextual={homeReturnToContextual}
															branchPillSlot={
																<BranchSelectorPopover
																	isOpen={homeBranchActions.isBranchPopoverOpen}
																	onOpenChange={homeBranchActions.setBranchPopoverOpen}
																	branches={homeBranchActions.branches}
																	currentBranch={homeBranchActions.currentBranch}
																	worktreeBranches={homeBranchActions.worktreeBranches}
																	onSelectBranchView={homeBranchActions.handleSelectBranchView}
																	onCheckoutBranch={homeBranchActions.handleCheckoutBranch}
																	onCompareWithBranch={(branch) =>
																		openGitCompare({ targetRef: branch })
																	}
																	trigger={
																		<BranchPillTrigger
																			label={
																				homeResolvedScope?.type === "branch_view"
																					? homeResolvedScope.ref
																					: (homeGitSummary?.currentBranch ?? "unknown")
																			}
																		/>
																	}
																/>
															}
															onCheckoutBrowsingBranch={
																homeResolvedScope?.type === "branch_view"
																	? () => homeBranchActions.handleCheckoutBranch(homeResolvedScope.ref)
																	: undefined
															}
														/>
													}
													fileBrowserData={homeFileBrowserData}
													rootPath={workspacePath}
												/>
											) : (
												<QuarterdeckBoard
													data={board}
													taskSessions={sessions}
													onCardSelect={handleCardSelect}
													onCreateTask={handleOpenCreateTask}
													onStartAllTasks={handleStartAllBacklogTasksFromBoard}
													onClearTrash={handleOpenClearTrash}
													editingTaskId={editingTaskId}
													inlineTaskEditor={inlineTaskEditor}
													onEditTask={handleOpenEditTask}
													dependencies={board.dependencies}
													onCreateDependency={handleCreateDependency}
													onDeleteDependency={handleDeleteDependency}
													onRequestProgrammaticCardMoveReady={handleProgrammaticCardMoveReady}
													onDragEnd={handleDragEnd}
												/>
											)}
										</div>
										{showHomeBottomTerminal ? (
											<ResizableBottomPane
												minHeight={200}
												initialHeight={homeTerminalPaneHeight}
												onHeightChange={setHomeTerminalPaneHeight}
												onCollapse={collapseHomeTerminal}
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
														key={`home-shell-${homeTerminalTaskId}`}
														taskId={homeTerminalTaskId}
														workspaceId={currentProjectId}
														summary={homeTerminalSummary}
														onSummary={upsertSession}
														showSessionToolbar={false}
														autoFocus
														onClose={closeHomeTerminal}
														minimalHeaderTitle="Terminal"
														minimalHeaderSubtitle={homeTerminalSubtitle}
														panelBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
														terminalBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
														cursorColor={TERMINAL_THEME_COLORS.textPrimary}
														onConnectionReady={markTerminalConnectionReady}
														agentCommand={agentCommand}
														onSendAgentCommand={handleSendAgentCommandToHomeTerminal}
														isExpanded={isHomeTerminalExpanded}
														onToggleExpand={handleToggleExpandHomeTerminal}
														onRestart={handleRestartHomeTerminal}
														onExit={handleShellExit}
													/>
												</div>
											</ResizableBottomPane>
										) : null}
									</div>
								)}
							</div>
						</div>
					)}
					{debugLogging.isDebugLogPanelOpen ? (
						<DebugLogPanel
							entries={debugLogging.filteredEntries}
							entryCount={debugLogging.entryCount}
							levelFilter={debugLogging.levelFilter}
							sourceFilter={debugLogging.sourceFilter}
							searchText={debugLogging.searchText}
							showConsoleCapture={debugLogging.showConsoleCapture}
							onSetLevelFilter={debugLogging.setLevelFilter}
							onSetSourceFilter={debugLogging.setSourceFilter}
							onSetSearchText={debugLogging.setSearchText}
							onSetShowConsoleCapture={debugLogging.setShowConsoleCapture}
							onClear={debugLogging.clearLogEntries}
							onClose={debugLogging.closeDebugLogPanel}
							onStopLogging={debugLogging.stopLogging}
						/>
					) : null}
					<RuntimeSettingsDialog
						open={isSettingsOpen}
						workspaceId={settingsWorkspaceId}
						initialConfig={settingsRuntimeProjectConfig}
						initialSection={settingsInitialSection}
						onOpenChange={(nextOpen) => {
							setIsSettingsOpen(nextOpen);
							if (!nextOpen) {
								setSettingsInitialSection(null);
							}
						}}
						onSaved={() => {
							refreshRuntimeProjectConfig();
							refreshSettingsRuntimeProjectConfig();
						}}
					/>
					<PromptShortcutEditorDialog
						open={promptShortcutEditorOpen}
						onOpenChange={setPromptShortcutEditorOpen}
						shortcuts={runtimeProjectConfig?.promptShortcuts ?? []}
						hiddenDefaultPromptShortcuts={runtimeProjectConfig?.hiddenDefaultPromptShortcuts ?? []}
						onSave={savePromptShortcuts}
					/>
					<DebugDialog
						open={isDebugDialogOpen}
						onOpenChange={handleDebugDialogOpenChange}
						isResetAllStatePending={isResetAllStatePending}
						onShowStartupOnboardingDialog={handleShowStartupOnboardingDialog}
						onResetAllState={handleResetAllState}
					/>
					<TaskCreateDialog
						open={isInlineTaskCreateOpen}
						onOpenChange={handleCreateDialogOpenChange}
						prompt={newTaskPrompt}
						onPromptChange={setNewTaskPrompt}
						images={newTaskImages}
						onImagesChange={setNewTaskImages}
						onCreate={handleCreateTask}
						onCreateAndStart={handleCreateAndStartTask}
						onCreateStartAndOpen={handleCreateStartAndOpenTask}
						onCreateMultiple={handleCreateTasks}
						onCreateAndStartMultiple={handleCreateAndStartTasks}
						startInPlanMode={newTaskStartInPlanMode}
						onStartInPlanModeChange={setNewTaskStartInPlanMode}
						startInPlanModeDisabled={isNewTaskStartInPlanModeDisabled}
						autoReviewEnabled={newTaskAutoReviewEnabled}
						onAutoReviewEnabledChange={setNewTaskAutoReviewEnabled}
						useWorktree={newTaskUseWorktree}
						onUseWorktreeChange={setNewTaskUseWorktree}
						currentBranch={workspaceGit?.currentBranch ?? null}
						createFeatureBranch={createFeatureBranch}
						onCreateFeatureBranchChange={setCreateFeatureBranch}
						branchName={branchName}
						onBranchNameEdit={handleBranchNameEdit}
						onGenerateBranchName={generateBranchNameFromPrompt}
						isGeneratingBranchName={isGeneratingBranchName}
						isLlmGenerationDisabled={isLlmGenerationDisabled}
						workspaceId={currentProjectId}
						branchRef={newTaskBranchRef}
						branchOptions={createTaskBranchOptions}
						onBranchRefChange={setNewTaskBranchRef}
					/>
					<ClearTrashDialog
						open={isClearTrashDialogOpen}
						taskCount={trashTaskCount}
						onCancel={() => setIsClearTrashDialogOpen(false)}
						onConfirm={handleConfirmClearTrash}
					/>
					<TaskTrashWarningDialog
						open={trashWarningState.open}
						warning={trashWarningState.warning}
						onCancel={handleCancelTrashWarning}
						onConfirm={handleConfirmTrashWarning}
					/>
					<CheckoutConfirmationDialog
						state={homeBranchActions.checkoutDialogState}
						onClose={homeBranchActions.closeCheckoutDialog}
						onConfirmCheckout={homeBranchActions.handleConfirmCheckout}
					/>
					<CheckoutConfirmationDialog
						state={topbarBranchActions.checkoutDialogState}
						onClose={topbarBranchActions.closeCheckoutDialog}
						onConfirmCheckout={topbarBranchActions.handleConfirmCheckout}
						onSkipTaskConfirmationChange={handleSkipTaskCheckoutConfirmationChange}
					/>
					<MigrateWorkingDirectoryDialog
						open={pendingMigrate !== null}
						direction={pendingMigrate?.direction ?? "isolate"}
						isMigrating={migratingTaskId !== null}
						onCancel={() => setPendingMigrate(null)}
						onConfirm={handleConfirmMigrate}
					/>
					<StartupOnboardingDialog
						open={isStartupOnboardingDialogOpen}
						onClose={handleCloseStartupOnboardingDialog}
						selectedAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
						agents={runtimeProjectConfig?.agents ?? []}
						workspaceId={currentProjectId}
						runtimeConfig={runtimeProjectConfig ?? null}
						onSelectAgent={handleSelectOnboardingAgent}
					/>

					<GitInitDialog
						open={pendingGitInitializationPath !== null}
						path={pendingGitInitializationPath}
						isInitializing={isInitializingGitProject}
						onCancel={handleCancelInitializeGitProject}
						onConfirm={() => {
							void handleConfirmInitializeGitProject();
						}}
					/>
					<GitActionErrorDialog
						open={gitActionError !== null}
						title={gitActionErrorTitle}
						message={gitActionError?.message ?? ""}
						output={gitActionError?.output ?? null}
						onClose={clearGitActionError}
					/>
				</div>
			</LayoutCustomizationsProvider>
		</CardActionsProvider>
	);
}
