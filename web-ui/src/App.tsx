// Main React composition root for the browser app.
// Keep this file focused on wiring top-level hooks and surfaces together, and
// push runtime-specific orchestration down into hooks and service modules.

import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	AppDialogs,
	ConnectedTopBar,
	HomeView,
	ProjectNavigationPanel,
	QuarterdeckAccessBlockedFallback,
	RuntimeDisconnectedFallback,
} from "@/components/app";
import { GitHistoryView } from "@/components/git";
import { CommitPanel } from "@/components/git/panels";
import { FileFinderOverlay } from "@/components/search/file-finder-overlay";
import { TextSearchOverlay } from "@/components/search/text-search-overlay";
import { CardDetailView, TaskInlineCreateCard } from "@/components/task";
import { DetailToolbar } from "@/components/terminal";
import { createInitialBoardData } from "@/data/board-data";
import { useAppActionModels, useAppSideEffects, useHomeSidePanelResize, useNavbarState } from "@/hooks/app";
import { usePromptShortcuts } from "@/hooks/board";
import { useProjectUiState } from "@/hooks/project";
import { useShortcutActions } from "@/hooks/settings";
import { useTerminalConfigSync } from "@/hooks/terminal";
import { BoardProvider, useBoardContext } from "@/providers/board-provider";
import { DialogProvider, useDialogContext } from "@/providers/dialog-provider";
import { GitProvider, useGitContext } from "@/providers/git-provider";
import { InteractionsProvider, useInteractionsContext } from "@/providers/interactions-provider";
import { ProjectProvider, useProjectContext } from "@/providers/project-provider";
import { TerminalProvider, useTerminalContext } from "@/providers/terminal-provider";
import { LayoutCustomizationsProvider, useLayoutResetEffect } from "@/resize/layout-customizations";
import { ResizeHandle } from "@/resize/resize-handle";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { CardActionsProvider } from "@/state/card-actions-context";
import {
	useHomeGitSummaryValue,
	useTaskWorktreeInfoValue,
	useTaskWorktreeSnapshotValue,
} from "@/stores/project-metadata-store";
import { initPool } from "@/terminal/terminal-pool";
import type { BoardData } from "@/types";

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
	searchOverlayResetRef: React.MutableRefObject<() => void>;
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
	const [canPersistProjectState, setCanPersistProjectState] = useState(false);
	const [isGitHistoryOpen, setIsGitHistoryOpen] = useState(false);
	const [pendingTaskStartAfterEditId, setPendingTaskStartAfterEditId] = useState<string | null>(null);
	const taskEditorResetRef = useRef<() => void>(() => {});
	const boardRef = useRef(board);
	boardRef.current = board;
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;

	const searchOverlayResetRef = useRef<() => void>(() => {});

	const handleProjectSwitchStart = useCallback(() => {
		setCanPersistProjectState(false);
		setIsGitHistoryOpen(false);
		setPendingTaskStartAfterEditId(null);
		taskEditorResetRef.current();
		searchOverlayResetRef.current();
	}, []);

	return (
		<ProjectProvider
			onProjectSwitchStart={handleProjectSwitchStart}
			boardRef={boardRef}
			sessionsRef={sessionsRef}
			setBoard={setBoard}
			setSessions={setSessions}
			canPersistProjectState={canPersistProjectState}
			setCanPersistProjectState={setCanPersistProjectState}
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
										searchOverlayResetRef={searchOverlayResetRef}
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

function AppContent({
	pendingTaskStartAfterEditId,
	clearPendingTaskStartAfterEditId,
	searchOverlayResetRef,
}: AppContentProps): ReactElement {
	const project = useProjectContext();
	const boardContext = useBoardContext();
	const {
		board,
		selectedTaskId,
		selectedCard,
		setSelectedTaskId,
		sendTaskSessionInput,
		taskEditor,
		createTaskBranchOptions,
		isAwaitingProjectSnapshot,
	} = boardContext;
	const git = useGitContext();
	const terminal = useTerminalContext();
	const interactions = useInteractionsContext();
	const dialog = useDialogContext();

	// --- Store subscriptions + derived UI state ---

	const selectedTaskWorktreeInfo = useTaskWorktreeInfoValue(selectedCard?.card.id, selectedCard?.card.baseRef);
	const selectedTaskWorktreeSnapshot = useTaskWorktreeSnapshotValue(selectedCard?.card.id);
	const homeGitSummary = useHomeGitSummaryValue();

	const {
		displayedProjects,
		navigationProjectPath,
		shouldShowProjectLoadingState,
		isProjectListLoading,
		shouldUseNavigationPath,
	} = useProjectUiState({
		board,
		canPersistProjectState: project.canPersistProjectState,
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
		isAwaitingProjectSnapshot,
		isProjectMetadataPending: project.isProjectMetadataPending,
		isServedFromBoardCache: project.isServedFromBoardCache,
		hasReceivedSnapshot: project.hasReceivedSnapshot,
	});

	const serverMutationInFlightRef = useRef(false);

	// --- Search overlay state ---

	const [isFileFinderOpen, setIsFileFinderOpen] = useState(false);
	const [isTextSearchOpen, setIsTextSearchOpen] = useState(false);

	const handleToggleFileFinder = useCallback(() => {
		setIsTextSearchOpen(false);
		setIsFileFinderOpen((prev) => !prev);
	}, []);

	const handleToggleTextSearch = useCallback(() => {
		setIsFileFinderOpen(false);
		setIsTextSearchOpen((prev) => !prev);
	}, []);

	const handleSearchFileSelect = useCallback(
		(filePath: string, lineNumber?: number) => {
			setIsFileFinderOpen(false);
			setIsTextSearchOpen(false);
			git.navigateToFile({ targetView: "files", filePath, lineNumber });
		},
		[git.navigateToFile],
	);

	useEffect(() => {
		searchOverlayResetRef.current = () => {
			setIsFileFinderOpen(false);
			setIsTextSearchOpen(false);
		};
	}, [searchOverlayResetRef]);

	// --- Side-effect hooks ---

	useTerminalConfigSync({
		terminalFontWeight: project.terminalFontWeight,
	});
	useAppSideEffects({
		project,
		board: boardContext,
		git,
		terminal,
		interactions,
		dialog,
		pendingTaskStartAfterEditId,
		clearPendingTaskStartAfterEditId,
		serverMutationInFlightRef,
		handleToggleFileFinder,
		handleToggleTextSearch,
	});

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

	const {
		stableCardActions,
		reactiveCardState,
		pendingMigrate,
		migratingTaskId,
		handleConfirmMigrate,
		cancelMigrate,
		handleMainViewChange,
		handleCardSelectWithFocus,
		handleCardDoubleClick,
		handleBack,
		projectsBadgeColor,
		boardBadgeColor,
		detailSession,
	} = useAppActionModels({
		project,
		board: boardContext,
		git,
		interactions,
		serverMutationInFlightRef,
	});

	const { sidebarAreaRef, homeSidePanelPercent, handleHomeSidePanelSeparatorMouseDown } = useHomeSidePanelResize({
		sidePanelRatio: git.sidePanelRatio,
		setSidePanelRatio: git.setSidePanelRatio,
	});

	const { navbarProjectPath, navbarProjectHint, navbarRuntimeHint, shouldHideProjectDependentTopBarActions } =
		useNavbarState({
			selectedCard,
			selectedTaskWorktreeInfo: selectedTaskWorktreeInfo,
			selectedTaskWorktreeSnapshot: selectedTaskWorktreeSnapshot,
			projectPath: project.projectPath,
			shouldUseNavigationPath: shouldUseNavigationPath,
			navigationProjectPath: navigationProjectPath,
			runtimeProjectConfig: project.runtimeProjectConfig,
			hasNoProjects: project.hasNoProjects,
			isProjectSwitching: project.isProjectSwitching,
			isAwaitingProjectSnapshot: isAwaitingProjectSnapshot,
			isProjectMetadataPending: project.isProjectMetadataPending,
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
			projectId={project.currentProjectId}
			branchRef={editTaskBranchRef}
			branchOptions={createTaskBranchOptions}
			onBranchRefChange={setEditTaskBranchRef}
			defaultBaseRef={project.configDefaultBaseRef}
			onSetDefaultBaseRef={project.handleSetDefaultBaseRef}
			mode="edit"
			idPrefix={`inline-edit-task-${editingTaskId}`}
		/>
	) : undefined;

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
			navbarProjectPath={navbarProjectPath}
			navbarProjectHint={navbarProjectHint}
			navbarRuntimeHint={navbarRuntimeHint}
			shouldHideProjectDependentTopBarActions={shouldHideProjectDependentTopBarActions}
			shouldShowProjectLoadingState={shouldShowProjectLoadingState}
			homeGitSummary={homeGitSummary}
			selectedTaskWorktreeSnapshot={selectedTaskWorktreeSnapshot}
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
									? (selectedTaskWorktreeSnapshot?.changedFiles ?? 0) > 0
										? "red"
										: project.unmergedChangesIndicatorEnabled &&
												(selectedTaskWorktreeSnapshot?.hasUnmergedChanges ?? false)
											? "blue"
											: undefined
									: (homeGitSummary?.changedFiles ?? 0) > 0
										? "red"
										: undefined
							}
							isBehindBase={
								project.behindBaseIndicatorEnabled && selectedCard
									? (selectedTaskWorktreeSnapshot?.behindBaseCount ?? 0) > 0
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
										projectId={project.currentProjectId ?? ""}
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
										notificationProjectIds={project.notificationProjectIds}
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
										projectId={project.currentProjectId}
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
					{isFileFinderOpen && (
						<FileFinderOverlay
							projectId={project.currentProjectId}
							onSelect={handleSearchFileSelect}
							onDismiss={() => setIsFileFinderOpen(false)}
						/>
					)}
					{isTextSearchOpen && (
						<TextSearchOverlay
							projectId={project.currentProjectId}
							onSelect={handleSearchFileSelect}
							onDismiss={() => setIsTextSearchOpen(false)}
						/>
					)}
				</div>
			</LayoutCustomizationsProvider>
		</CardActionsProvider>
	);
}
