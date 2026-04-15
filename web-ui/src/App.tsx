// Main React composition root for the browser app.
// Keep this file focused on wiring top-level hooks and surfaces together, and
// push runtime-specific orchestration down into hooks and service modules.

import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { ArrowDown, ArrowUp, CircleArrowDown, FolderOpen } from "lucide-react";
import type { ReactElement, MouseEvent as ReactMouseEvent } from "react";
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
import { useAppDialogs } from "@/hooks/use-app-dialogs";
import { useAppHotkeys } from "@/hooks/use-app-hotkeys";
import { useAudibleNotifications } from "@/hooks/use-audible-notifications";
import { useBoardInteractions } from "@/hooks/use-board-interactions";
import { useBoardMetadataSync } from "@/hooks/use-board-metadata-sync";
import { useBranchActions } from "@/hooks/use-branch-actions";
import { useDebugLogging } from "@/hooks/use-debug-logging";
import { useDebugTools } from "@/hooks/use-debug-tools";
import { useDetailTaskNavigation } from "@/hooks/use-detail-task-navigation";
import { useDisplaySummaryOnHover } from "@/hooks/use-display-summary";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { useEscapeHandler } from "@/hooks/use-escape-handler";
import { useFileBrowserData } from "@/hooks/use-file-browser-data";
import { useFocusedTaskNotification } from "@/hooks/use-focused-task-notification";
import { useGitActions } from "@/hooks/use-git-actions";
import { useGitNavigation } from "@/hooks/use-git-navigation";
import { useMigrateTaskDialog } from "@/hooks/use-migrate-task-dialog";
import { useNavbarState } from "@/hooks/use-navbar-state";
import { useProjectNavigation } from "@/hooks/use-project-navigation";
import { useProjectSwitchCleanup } from "@/hooks/use-project-switch-cleanup";
import { useProjectUiState } from "@/hooks/use-project-ui-state";
import { usePromptShortcuts } from "@/hooks/use-prompt-shortcuts";
import { useQuarterdeckAccessGate } from "@/hooks/use-quarterdeck-access-gate";
import { useReviewReadyNotifications } from "@/hooks/use-review-ready-notifications";
import { useScopeContext } from "@/hooks/use-scope-context";
import { useShortcutActions } from "@/hooks/use-shortcut-actions";
import { useStartupOnboarding } from "@/hooks/use-startup-onboarding";
import { useStreamErrorHandler } from "@/hooks/use-stream-error-handler";
import { useTaskBranchOptions } from "@/hooks/use-task-branch-options";
import { useTaskEditor } from "@/hooks/use-task-editor";
import { useTaskSessions } from "@/hooks/use-task-sessions";
import { useTaskStartActions } from "@/hooks/use-task-start-actions";
import { useTaskTitleSync } from "@/hooks/use-task-title-sync";
import { useTerminalConfigSync } from "@/hooks/use-terminal-config-sync";
import { useTerminalPanels } from "@/hooks/use-terminal-panels";
import { useTitleActions } from "@/hooks/use-title-actions";
import { useWorkspaceSync } from "@/hooks/use-workspace-sync";
import { DialogContext, type DialogContextValue } from "@/providers/dialog-provider";
import { ProjectContext, type ProjectContextValue } from "@/providers/project-provider";
import { LayoutCustomizationsProvider, useLayoutResetEffect } from "@/resize/layout-customizations";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import { ResizeHandle } from "@/resize/resize-handle";
import { type MainViewId, useCardDetailLayout } from "@/resize/use-card-detail-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import { saveRuntimeConfig } from "@/runtime/runtime-config-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useRuntimeProjectConfig } from "@/runtime/use-runtime-project-config";
import { useTerminalConnectionReady } from "@/runtime/use-terminal-connection-ready";
import { useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { saveWorkspaceState } from "@/runtime/workspace-state-query";
import { findCardSelection, reconcileTaskWorkingDirectory, toggleTaskPinned } from "@/state/board-state";
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
	const [isGitHistoryOpen, setIsGitHistoryOpen] = useState(false);
	const [pendingTaskStartAfterEditId, setPendingTaskStartAfterEditId] = useState<string | null>(null);
	const taskEditorResetRef = useRef<() => void>(() => {});
	const boardRef = useRef(board);
	boardRef.current = board;
	const findCardStable = useCallback(
		(cardId: string) => findCardSelection(boardRef.current, cardId)?.card ?? null,
		[],
	);
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
		handleOpenDebugDialog,
		handleShowStartupOnboardingDialog,
		handleDebugDialogOpenChange,
	} = useDebugTools({
		runtimeProjectConfig,
		settingsRuntimeProjectConfig,
		onOpenStartupOnboardingDialog: handleOpenStartupOnboardingDialog,
	});
	const debugLogging = useDebugLogging({
		currentProjectId,
		logLevel,
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
	const handleTerminalWarmup = useCallback(
		(taskId: string) => {
			if (currentProjectId) warmup(taskId, currentProjectId);
		},
		[currentProjectId],
	);
	const handleTerminalCancelWarmup = useCallback(
		(taskId: string) => {
			if (currentProjectId) cancelWarmup(taskId);
		},
		[currentProjectId],
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

	useFocusedTaskNotification({ currentProjectId, selectedTaskId });

	// Reactive subscriptions — re-render when the metadata store updates for the selected task.
	const selectedTaskWorkspaceInfo = useTaskWorkspaceInfoValue(selectedCard?.card.id, selectedCard?.card.baseRef);
	const selectedTaskWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(selectedCard?.card.id);
	const homeGitSummary = useHomeGitSummaryValue();

	const {
		scopeMode: fileBrowserScopeMode,
		resolvedScope: fileBrowserResolvedScope,
		switchToHome: fileBrowserSwitchToHome,
		returnToContextual: fileBrowserReturnToContextual,
		selectBranchView: fileBrowserSelectBranchView,
	} = useScopeContext({
		selectedTaskId: null,
		selectedCard: null,
		currentProjectId,
	});

	const skipTaskCheckoutConfirmation = runtimeProjectConfig?.skipTaskCheckoutConfirmation ?? false;
	const skipHomeCheckoutConfirmation = runtimeProjectConfig?.skipHomeCheckoutConfirmation ?? false;
	const skipCherryPickConfirmation = runtimeProjectConfig?.skipCherryPickConfirmation ?? false;
	const pinnedBranches = runtimeProjectConfig?.pinnedBranches ?? [];

	const handleTogglePinBranch = useCallback(
		(branchName: string) => {
			if (!currentProjectId) return;
			const current = runtimeProjectConfig?.pinnedBranches ?? [];
			const next = current.includes(branchName) ? current.filter((b) => b !== branchName) : [...current, branchName];
			void saveRuntimeConfig(currentProjectId, { pinnedBranches: next })
				.then(() => {
					refreshRuntimeProjectConfig();
				})
				.catch(() => {
					showAppToast({ intent: "danger", message: "Failed to update pinned branches" });
				});
		},
		[currentProjectId, runtimeProjectConfig?.pinnedBranches, refreshRuntimeProjectConfig],
	);

	const handleSkipTaskCheckoutConfirmationChange = useCallback(
		(skip: boolean) => {
			if (!currentProjectId) return;
			void saveRuntimeConfig(currentProjectId, { skipTaskCheckoutConfirmation: skip }).then(() => {
				refreshRuntimeProjectConfig();
			});
		},
		[currentProjectId, refreshRuntimeProjectConfig],
	);

	// Ref-based callback: setMainView is declared later (useCardDetailLayout), but
	// onConflictDetected fires asynchronously from a mutation, never during render.
	const navigateToGitViewRef = useRef<(() => void) | null>(null);

	const fileBrowserBranchActions = useBranchActions({
		workspaceId: currentProjectId,
		board,
		selectBranchView: fileBrowserSelectBranchView,
		homeGitSummary,
		skipHomeCheckoutConfirmation,
		skipTaskCheckoutConfirmation,
		onCheckoutSuccess: fileBrowserReturnToContextual,
		onConflictDetected: () => navigateToGitViewRef.current?.(),
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
		onConflictDetected: () => navigateToGitViewRef.current?.(),
	});

	const topbarBranchLabel = useMemo(() => {
		if (selectedCard) {
			if (selectedTaskWorkspaceInfo?.branch) return selectedTaskWorkspaceInfo.branch;
			// When workspace info reports detached HEAD, skip stale card.branch and show commit hash
			if (selectedTaskWorkspaceInfo?.isDetached)
				return selectedTaskWorkspaceInfo.headCommit?.substring(0, 7) ?? null;
			return selectedCard.card.branch ?? selectedTaskWorkspaceInfo?.headCommit?.substring(0, 7) ?? null;
		}
		return homeGitSummary?.currentBranch ?? null;
	}, [selectedCard, selectedTaskWorkspaceInfo, homeGitSummary]);

	// Home-scope file browser data + tree state
	const homeFileBrowserData = useFileBrowserData({
		workspaceId: currentProjectId,
		taskId: fileBrowserResolvedScope?.type === "task" ? fileBrowserResolvedScope.taskId : null,
		baseRef: fileBrowserResolvedScope?.type === "task" ? fileBrowserResolvedScope.baseRef : undefined,
		ref: fileBrowserResolvedScope?.type === "branch_view" ? fileBrowserResolvedScope.ref : undefined,
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

	useBoardMetadataSync({ workspaceMetadata, setBoard });

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
	const audibleNotificationSuppressCurrentProject =
		runtimeProjectConfig?.audibleNotificationSuppressCurrentProject ??
		CONFIG_DEFAULTS.audibleNotificationSuppressCurrentProject;

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
		audibleNotificationSuppressCurrentProject,
		notificationWorkspaceIds,
		currentProjectId,
		suppressedTaskIds: trashTaskIdSet,
	});

	const terminalFontWeight = runtimeProjectConfig?.terminalFontWeight ?? CONFIG_DEFAULTS.terminalFontWeight;
	const terminalWebGLRenderer = runtimeProjectConfig?.terminalWebGLRenderer ?? CONFIG_DEFAULTS.terminalWebGLRenderer;
	useTerminalConfigSync({ terminalFontWeight, terminalWebGLRenderer });

	useTaskTitleSync({ latestTaskTitleUpdate, setBoard });

	const configDefaultBaseRef = runtimeProjectConfig?.defaultBaseRef ?? "";
	const { createTaskBranchOptions, defaultTaskBranchRef, isConfigDefaultBaseRef } = useTaskBranchOptions({
		workspaceGit,
		configDefaultBaseRef,
	});
	const handleSetDefaultBaseRef = useCallback(
		async (value: string | null) => {
			const nextValue = value ?? "";
			try {
				await saveRuntimeConfig(currentProjectId, { defaultBaseRef: nextValue });
				refreshRuntimeProjectConfig();
				showAppToast({
					intent: "success",
					message: nextValue ? `Default base ref set to ${nextValue}` : "Default base ref cleared",
					timeout: 2000,
				});
			} catch {
				showAppToast({ intent: "danger", message: "Failed to update default base ref" });
			}
		},
		[currentProjectId, refreshRuntimeProjectConfig],
	);
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
		isConfigDefaultBaseRef,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});

	const {
		isSettingsOpen,
		setIsSettingsOpen,
		settingsInitialSection,
		setSettingsInitialSection,
		isClearTrashDialogOpen,
		setIsClearTrashDialogOpen,
		promptShortcutEditorOpen,
		setPromptShortcutEditorOpen,
		handleOpenSettings,
		handleCreateDialogOpenChange,
	} = useAppDialogs({ handleCancelCreateTask });

	const dialogContextValue = useMemo<DialogContextValue>(
		() => ({
			isSettingsOpen,
			setIsSettingsOpen,
			settingsInitialSection,
			setSettingsInitialSection,
			handleOpenSettings,
			isClearTrashDialogOpen,
			setIsClearTrashDialogOpen,
			promptShortcutEditorOpen,
			setPromptShortcutEditorOpen,
			handleCreateDialogOpenChange,
			debugModeEnabled,
			isDebugDialogOpen,
			handleOpenDebugDialog,
			handleShowStartupOnboardingDialog,
			handleDebugDialogOpenChange,
			debugLogging,
		}),
		[
			isSettingsOpen,
			setIsSettingsOpen,
			settingsInitialSection,
			setSettingsInitialSection,
			handleOpenSettings,
			isClearTrashDialogOpen,
			setIsClearTrashDialogOpen,
			promptShortcutEditorOpen,
			setPromptShortcutEditorOpen,
			handleCreateDialogOpenChange,
			debugModeEnabled,
			isDebugDialogOpen,
			handleOpenDebugDialog,
			handleShowStartupOnboardingDialog,
			handleDebugDialogOpenChange,
			debugLogging,
		],
	);

	const agentCommand = runtimeProjectConfig?.effectiveCommand ?? null;

	const projectContextValue = useMemo<ProjectContextValue>(
		() => ({
			// useProjectNavigation
			currentProjectId,
			projects,
			streamedWorkspaceState,
			workspaceMetadata,
			notificationSessions,
			notificationWorkspaceIds,
			latestTaskReadyForReview,
			latestTaskTitleUpdate,
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

			// Runtime project config (current project)
			runtimeProjectConfig,
			isRuntimeProjectConfigLoading,
			refreshRuntimeProjectConfig,

			// Runtime project config (settings scope)
			settingsRuntimeProjectConfig,
			refreshSettingsRuntimeProjectConfig,

			// useStartupOnboarding
			isStartupOnboardingDialogOpen,
			handleOpenStartupOnboardingDialog,
			handleCloseStartupOnboardingDialog,
			handleSelectOnboardingAgent,

			// useQuarterdeckAccessGate
			isQuarterdeckAccessBlocked,

			// Derived config values
			isTaskAgentReady,
			settingsWorkspaceId,
			llmConfigured,
			isLlmGenerationDisabled,
			shortcuts,
			selectedShortcutLabel,
			skipTaskCheckoutConfirmation,
			skipHomeCheckoutConfirmation,
			skipCherryPickConfirmation,
			pinnedBranches,
			showTrashWorktreeNotice,
			unmergedChangesIndicatorEnabled,
			behindBaseIndicatorEnabled,
			audibleNotificationsEnabled,
			audibleNotificationVolume,
			audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden,
			audibleNotificationSuppressCurrentProject,
			terminalFontWeight,
			terminalWebGLRenderer,
			agentCommand,
			configDefaultBaseRef,

			// Config mutation callbacks
			handleTogglePinBranch,
			handleSkipTaskCheckoutConfirmationChange,
			handleSetDefaultBaseRef,
			saveTrashWorktreeNoticeDismissed,
		}),
		[
			currentProjectId,
			projects,
			streamedWorkspaceState,
			workspaceMetadata,
			notificationSessions,
			notificationWorkspaceIds,
			latestTaskReadyForReview,
			latestTaskTitleUpdate,
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
			runtimeProjectConfig,
			isRuntimeProjectConfigLoading,
			refreshRuntimeProjectConfig,
			settingsRuntimeProjectConfig,
			refreshSettingsRuntimeProjectConfig,
			isStartupOnboardingDialogOpen,
			handleOpenStartupOnboardingDialog,
			handleCloseStartupOnboardingDialog,
			handleSelectOnboardingAgent,
			isQuarterdeckAccessBlocked,
			isTaskAgentReady,
			settingsWorkspaceId,
			llmConfigured,
			isLlmGenerationDisabled,
			shortcuts,
			selectedShortcutLabel,
			skipTaskCheckoutConfirmation,
			skipHomeCheckoutConfirmation,
			skipCherryPickConfirmation,
			pinnedBranches,
			showTrashWorktreeNotice,
			unmergedChangesIndicatorEnabled,
			behindBaseIndicatorEnabled,
			audibleNotificationsEnabled,
			audibleNotificationVolume,
			audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden,
			audibleNotificationSuppressCurrentProject,
			terminalFontWeight,
			terminalWebGLRenderer,
			agentCommand,
			configDefaultBaseRef,
			handleTogglePinBranch,
			handleSkipTaskCheckoutConfirmationChange,
			handleSetDefaultBaseRef,
			saveTrashWorktreeNoticeDismissed,
		],
	);

	useEffect(() => {
		taskEditorResetRef.current = resetTaskEditorState;
	}, [resetTaskEditorState]);

	const {
		runningGitAction,
		gitActionError,
		gitActionErrorTitle,
		clearGitActionError,
		gitHistory,
		gitHistoryTaskScope,
		runGitAction,
		switchHomeBranch,
		resetGitActionState,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
		onStashAndRetry,
		isStashAndRetryingPull,
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

	useStreamErrorHandler({ streamError, isRuntimeDisconnected });

	useProjectSwitchCleanup({
		currentProjectId,
		isProjectSwitching,
		resetTaskEditorState,
		setIsClearTrashDialogOpen,
		resetGitActionState,
		resetProjectNavigationState,
		resetTerminalPanelsState,
		resetWorkspaceSyncState,
	});

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
		handleCardSelect,
		handleMoveReviewCardToTrash,
		handleRestoreTaskFromTrash,
		handleHardDeleteTrashTask,
		hardDeleteDialogState,
		handleCancelHardDelete,
		handleConfirmHardDelete,
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

	const { pendingMigrate, migratingTaskId, handleMigrateWorkingDirectory, handleConfirmMigrate, cancelMigrate } =
		useMigrateTaskDialog({
			currentProjectId,
			serverMutationInFlightRef,
			stopTaskSession,
			refreshWorkspaceState,
		});

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

	const {
		pendingCompareNavigation,
		pendingFileNavigation,
		openGitCompare,
		clearPendingCompareNavigation,
		navigateToFile,
		clearPendingFileNavigation,
		navigateToGitView,
	} = useGitNavigation({ isGitHistoryOpen, setMainView, setSelectedTaskId });

	// Wire the conflict navigation ref now that setMainView is available.
	navigateToGitViewRef.current = navigateToGitView;

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

	useEscapeHandler({ isGitHistoryOpen, setIsGitHistoryOpen, selectedCard, setSelectedTaskId });

	const { navbarWorkspacePath, navbarWorkspaceHint, navbarRuntimeHint, shouldHideProjectDependentTopBarActions } =
		useNavbarState({
			selectedCard,
			selectedTaskWorkspaceInfo,
			selectedTaskWorkspaceSnapshot,
			workspacePath,
			shouldUseNavigationPath,
			navigationProjectPath,
			runtimeProjectConfig,
			hasNoProjects,
			isProjectSwitching,
			isAwaitingWorkspaceSnapshot,
			isWorkspaceMetadataPending,
		});

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
			defaultBaseRef={configDefaultBaseRef}
			onSetDefaultBaseRef={handleSetDefaultBaseRef}
			mode="edit"
			idPrefix={`inline-edit-task-${editingTaskId}`}
		/>
	) : undefined;

	const handleFlagForDebug = useCallback(
		(taskId: string) => {
			if (!currentProjectId) return;
			getRuntimeTrpcClient(currentProjectId)
				.runtime.flagTaskForDebug.mutate({ taskId })
				.then((result) => {
					if (result.ok) {
						showAppToast({ message: "Flagged in event log", intent: "success", timeout: 2000 });
					}
				})
				.catch(() => {
					// Best effort — the button is a convenience, not critical.
				});
		},
		[currentProjectId],
	);

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
			onTerminalWarmup: handleTerminalWarmup,
			onTerminalCancelWarmup: handleTerminalCancelWarmup,
			onFlagForDebug: runtimeProjectConfig?.eventLogEnabled ? handleFlagForDebug : undefined,
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
			handleTerminalWarmup,
			handleTerminalCancelWarmup,
			handleFlagForDebug,
			runtimeProjectConfig?.eventLogEnabled,
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

	// Board sidebar badge — orange dot when any task in the current project needs input.
	const boardBadgeColor: "orange" | undefined = useMemo(
		() =>
			Object.entries(notificationSessions).some(
				([taskId, session]) => notificationWorkspaceIds[taskId] === currentProjectId && isApprovalState(session),
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

	const gitSyncTaskScope = selectedCard
		? { taskId: selectedCard.card.id, baseRef: selectedCard.card.baseRef }
		: undefined;

	const topBar = (
		<TopBar
			onBack={selectedCard ? handleBack : undefined}
			workspacePath={navbarWorkspacePath}
			isWorkspacePathLoading={shouldShowProjectLoadingState}
			workspaceHint={navbarWorkspaceHint}
			runtimeHint={navbarRuntimeHint}
			selectedTaskId={selectedCard?.card.id ?? null}
			scopeType={selectedCard ? "task" : (fileBrowserResolvedScope?.type ?? "home")}
			taskTitle={selectedCard?.card.title ?? null}
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
			hideProjectDependentActions={shouldHideProjectDependentTopBarActions}
			branchPillSlot={
				topbarBranchLabel ? (
					<div className="flex items-center gap-1.5">
						<BranchSelectorPopover
							isOpen={topbarBranchActions.isBranchPopoverOpen}
							onOpenChange={topbarBranchActions.setBranchPopoverOpen}
							branches={topbarBranchActions.branches}
							currentBranch={topbarBranchActions.currentBranch}
							worktreeBranches={topbarBranchActions.worktreeBranches}
							onSelectBranchView={topbarBranchActions.handleSelectBranchView}
							onCheckoutBranch={topbarBranchActions.handleCheckoutBranch}
							onCompareWithBranch={(branch) => openGitCompare({ targetRef: branch })}
							onMergeBranch={topbarBranchActions.handleMergeBranch}
							onCreateBranch={topbarBranchActions.handleCreateBranchFrom}
							onDeleteBranch={topbarBranchActions.handleDeleteBranch}
							onPull={(branch) => {
								void runGitAction("pull", gitSyncTaskScope ?? null, branch);
							}}
							onPush={(branch) => {
								void runGitAction("push", gitSyncTaskScope ?? null, branch);
							}}
							pinnedBranches={pinnedBranches}
							onTogglePinBranch={handleTogglePinBranch}
							trigger={
								<BranchPillTrigger
									label={topbarBranchLabel}
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
									icon={runningGitAction === "fetch" ? <Spinner size={12} /> : <CircleArrowDown size={14} />}
									onClick={() => {
										void runGitAction("fetch", gitSyncTaskScope);
									}}
									disabled={runningGitAction != null}
									aria-label="Fetch from upstream"
								/>
							</Tooltip>
							<Tooltip side="bottom" content="Pull from upstream">
								<Button
									variant="ghost"
									size="sm"
									className="h-6"
									icon={runningGitAction === "pull" ? <Spinner size={12} /> : <ArrowDown size={12} />}
									onClick={() => {
										void runGitAction("pull", gitSyncTaskScope);
									}}
									disabled={runningGitAction != null}
									aria-label="Pull from upstream"
								/>
							</Tooltip>
							<Tooltip side="bottom" content="Push to upstream">
								<Button
									variant="ghost"
									size="sm"
									className="h-6"
									icon={runningGitAction === "push" ? <Spinner size={12} /> : <ArrowUp size={12} />}
									onClick={() => {
										void runGitAction("push", gitSyncTaskScope);
									}}
									disabled={runningGitAction != null}
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
		<ProjectContext.Provider value={projectContextValue}>
			<DialogContext.Provider value={dialogContextValue}>
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
									boardBadgeColor={selectedCard ? boardBadgeColor : undefined}
								/>

								{/* Sidebar panel content — depends on sidebar state */}
								{sidebar === "commit" && !selectedCard ? (
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
												workspaceId={currentProjectId ?? ""}
												taskId={null}
												baseRef={null}
												navigateToFile={navigateToFile}
											/>
										</div>
										<ResizeHandle
											orientation="vertical"
											ariaLabel="Resize home side panel"
											onMouseDown={handleHomeSidePanelSeparatorMouseDown}
											className="z-10"
										/>
									</>
								) : sidebar === "projects" || (sidebar !== null && !selectedCard) ? (
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
												onSelectProject={(projectId) => {
													void handleSelectProject(projectId);
												}}
												onPreloadProject={handlePreloadProject}
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
											<GitHistoryView
												workspaceId={currentProjectId}
												gitHistory={gitHistory}
												onCreateBranch={fileBrowserBranchActions.handleCreateBranchFrom}
												onPullLatest={() => {
													void runGitAction("pull", gitHistoryTaskScope);
												}}
												taskScope={gitHistoryTaskScope}
												skipCherryPickConfirmation={skipCherryPickConfirmation}
											/>
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
									pendingFileNavigation={pendingFileNavigation}
									onFileNavigationConsumed={clearPendingFileNavigation}
									navigateToFile={navigateToFile}
									pinnedBranches={pinnedBranches}
									onTogglePinBranch={handleTogglePinBranch}
									onConflictDetected={() => navigateToGitViewRef.current?.()}
									onPullBranch={(branch) => {
										void runGitAction(
											"pull",
											{
												taskId: selectedCard.card.id,
												baseRef: selectedCard.card.baseRef,
											},
											branch,
										);
									}}
									onPushBranch={(branch) => {
										void runGitAction(
											"push",
											{
												taskId: selectedCard.card.id,
												baseRef: selectedCard.card.baseRef,
											},
											branch,
										);
									}}
								/>
							) : (
								<div className="flex flex-col flex-1 min-w-0 overflow-hidden">
									{topBar}
									{mainView !== "git" && (
										<ConflictBanner
											taskId={selectedTaskId}
											onNavigateToResolver={() => navigateToGitViewRef.current?.()}
										/>
									)}
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
															pendingFileNavigation={pendingFileNavigation}
															onFileNavigationConsumed={clearPendingFileNavigation}
															navigateToFile={navigateToFile}
															pinnedBranches={pinnedBranches}
															onTogglePinBranch={handleTogglePinBranch}
															branchStatusSlot={
																homeGitSummary ? (
																	<GitBranchStatusControl
																		branchLabel={homeGitSummary.currentBranch ?? "detached HEAD"}
																		changedFiles={homeGitSummary.changedFiles ?? 0}
																		additions={homeGitSummary.additions ?? 0}
																		deletions={homeGitSummary.deletions ?? 0}
																		onToggleGitHistory={handleToggleGitHistory}
																		isGitHistoryOpen={isGitHistoryOpen}
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
																		onCreateBranch={fileBrowserBranchActions.handleCreateBranchFrom}
																		onPullLatest={() => {
																			void runGitAction("pull");
																		}}
																		taskScope={gitHistoryTaskScope}
																		skipCherryPickConfirmation={skipCherryPickConfirmation}
																	/>
																) : undefined
															}
														/>
													) : mainView === "files" ? (
														<FilesView
															key={currentProjectId ?? "no-project"}
															scopeBar={
																<ScopeBar
																	resolvedScope={fileBrowserResolvedScope}
																	scopeMode={fileBrowserScopeMode}
																	homeGitSummary={homeGitSummary}
																	taskTitle={null}
																	taskBranch={null}
																	taskBaseRef={null}
																	behindBaseCount={null}
																	isDetachedHead={
																		homeGitSummary?.currentBranch === null && homeGitSummary !== null
																	}
																	onSwitchToHome={fileBrowserSwitchToHome}
																	onReturnToContextual={fileBrowserReturnToContextual}
																	branchPillSlot={
																		<BranchSelectorPopover
																			isOpen={fileBrowserBranchActions.isBranchPopoverOpen}
																			onOpenChange={fileBrowserBranchActions.setBranchPopoverOpen}
																			branches={fileBrowserBranchActions.branches}
																			currentBranch={fileBrowserBranchActions.currentBranch}
																			worktreeBranches={fileBrowserBranchActions.worktreeBranches}
																			onSelectBranchView={
																				fileBrowserBranchActions.handleSelectBranchView
																			}
																			onCheckoutBranch={
																				fileBrowserBranchActions.handleCheckoutBranch
																			}
																			onCompareWithBranch={(branch) =>
																				openGitCompare({ targetRef: branch })
																			}
																			onMergeBranch={fileBrowserBranchActions.handleMergeBranch}
																			onCreateBranch={
																				fileBrowserBranchActions.handleCreateBranchFrom
																			}
																			onDeleteBranch={fileBrowserBranchActions.handleDeleteBranch}
																			onPull={
																				fileBrowserResolvedScope?.type !== "branch_view"
																					? (branch) => {
																							void runGitAction("pull", null, branch);
																						}
																					: undefined
																			}
																			onPush={
																				fileBrowserResolvedScope?.type !== "branch_view"
																					? (branch) => {
																							void runGitAction("push", null, branch);
																						}
																					: undefined
																			}
																			pinnedBranches={pinnedBranches}
																			onTogglePinBranch={handleTogglePinBranch}
																			disableContextMenu
																			trigger={
																				<BranchPillTrigger
																					label={
																						fileBrowserResolvedScope?.type === "branch_view"
																							? fileBrowserResolvedScope.ref
																							: (homeGitSummary?.currentBranch ?? "unknown")
																					}
																					aheadCount={
																						fileBrowserResolvedScope?.type === "branch_view"
																							? undefined
																							: homeGitSummary?.aheadCount
																					}
																					behindCount={
																						fileBrowserResolvedScope?.type === "branch_view"
																							? undefined
																							: homeGitSummary?.behindCount
																					}
																				/>
																			}
																		/>
																	}
																	onCheckoutBrowsingBranch={
																		fileBrowserResolvedScope?.type === "branch_view"
																			? () =>
																					fileBrowserBranchActions.handleCheckoutBranch(
																						fileBrowserResolvedScope.ref,
																					)
																			: undefined
																	}
																/>
															}
															fileBrowserData={homeFileBrowserData}
															rootPath={workspacePath}
															pendingFileNavigation={pendingFileNavigation}
															onFileNavigationConsumed={clearPendingFileNavigation}
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
							<DebugShelf />
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
								defaultBaseRef={configDefaultBaseRef}
								onSetDefaultBaseRef={handleSetDefaultBaseRef}
							/>
							<ClearTrashDialog
								open={isClearTrashDialogOpen}
								taskCount={trashTaskCount}
								onCancel={() => setIsClearTrashDialogOpen(false)}
								onConfirm={handleConfirmClearTrash}
							/>
							<HardDeleteTaskDialog
								open={hardDeleteDialogState.open}
								taskTitle={hardDeleteDialogState.taskTitle}
								onCancel={handleCancelHardDelete}
								onConfirm={handleConfirmHardDelete}
							/>
							<TaskTrashWarningDialog
								open={trashWarningState.open}
								warning={trashWarningState.warning}
								onCancel={handleCancelTrashWarning}
								onConfirm={handleConfirmTrashWarning}
							/>
							<CheckoutConfirmationDialog
								state={fileBrowserBranchActions.checkoutDialogState}
								onClose={fileBrowserBranchActions.closeCheckoutDialog}
								onConfirmCheckout={fileBrowserBranchActions.handleConfirmCheckout}
								onStashAndCheckout={fileBrowserBranchActions.handleStashAndCheckout}
								isStashingAndCheckingOut={fileBrowserBranchActions.isStashingAndCheckingOut}
							/>
							<CheckoutConfirmationDialog
								state={topbarBranchActions.checkoutDialogState}
								onClose={topbarBranchActions.closeCheckoutDialog}
								onConfirmCheckout={topbarBranchActions.handleConfirmCheckout}
								onSkipTaskConfirmationChange={handleSkipTaskCheckoutConfirmationChange}
								onStashAndCheckout={topbarBranchActions.handleStashAndCheckout}
								isStashingAndCheckingOut={topbarBranchActions.isStashingAndCheckingOut}
							/>
							<CreateBranchDialog
								state={fileBrowserBranchActions.createBranchDialogState}
								workspaceId={currentProjectId}
								onClose={fileBrowserBranchActions.closeCreateBranchDialog}
								onBranchCreated={fileBrowserBranchActions.handleBranchCreated}
							/>
							<CreateBranchDialog
								state={topbarBranchActions.createBranchDialogState}
								workspaceId={currentProjectId}
								onClose={topbarBranchActions.closeCreateBranchDialog}
								onBranchCreated={topbarBranchActions.handleBranchCreated}
							/>
							<DeleteBranchDialog
								open={fileBrowserBranchActions.deleteBranchDialogState.type === "open"}
								branchName={
									fileBrowserBranchActions.deleteBranchDialogState.type === "open"
										? fileBrowserBranchActions.deleteBranchDialogState.branchName
										: ""
								}
								onCancel={fileBrowserBranchActions.closeDeleteBranchDialog}
								onConfirm={fileBrowserBranchActions.handleConfirmDeleteBranch}
							/>
							<DeleteBranchDialog
								open={topbarBranchActions.deleteBranchDialogState.type === "open"}
								branchName={
									topbarBranchActions.deleteBranchDialogState.type === "open"
										? topbarBranchActions.deleteBranchDialogState.branchName
										: ""
								}
								onCancel={topbarBranchActions.closeDeleteBranchDialog}
								onConfirm={topbarBranchActions.handleConfirmDeleteBranch}
							/>
							<MergeBranchDialog
								open={fileBrowserBranchActions.mergeBranchDialogState.type === "open"}
								branchName={
									fileBrowserBranchActions.mergeBranchDialogState.type === "open"
										? fileBrowserBranchActions.mergeBranchDialogState.branchName
										: ""
								}
								currentBranch={fileBrowserBranchActions.currentBranch ?? "current branch"}
								onCancel={fileBrowserBranchActions.closeMergeBranchDialog}
								onConfirm={fileBrowserBranchActions.handleConfirmMergeBranch}
							/>
							<MergeBranchDialog
								open={topbarBranchActions.mergeBranchDialogState.type === "open"}
								branchName={
									topbarBranchActions.mergeBranchDialogState.type === "open"
										? topbarBranchActions.mergeBranchDialogState.branchName
										: ""
								}
								currentBranch={topbarBranchActions.currentBranch ?? "current branch"}
								onCancel={topbarBranchActions.closeMergeBranchDialog}
								onConfirm={topbarBranchActions.handleConfirmMergeBranch}
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
								open={gitActionError !== null}
								title={gitActionErrorTitle}
								message={gitActionError?.message ?? ""}
								output={gitActionError?.output ?? null}
								onClose={clearGitActionError}
								onStashAndRetry={onStashAndRetry}
								isStashAndRetrying={isStashAndRetryingPull}
							/>
						</div>
					</LayoutCustomizationsProvider>
				</CardActionsProvider>
			</DialogContext.Provider>
		</ProjectContext.Provider>
	);
}
