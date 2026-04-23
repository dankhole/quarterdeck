// Main React composition root for the browser app.
// Keep this file focused on wiring top-level hooks and surfaces together, and
// push runtime-specific orchestration down into hooks and service modules.

import type { ReactElement, ReactNode, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	AlreadyOpenFallback,
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
import {
	useAppActionModels,
	useAppSideEffects,
	useHomeSidePanelResize,
	useNavbarState,
	useSingleTabGuard,
} from "@/hooks/app";
import { usePromptShortcuts } from "@/hooks/board";
import { useProjectUiState } from "@/hooks/project";
import type { ProjectBoardSessionsState } from "@/hooks/project/project-sync";
import { useShortcutActions } from "@/hooks/settings";
import { useTerminalConfigSync } from "@/hooks/terminal";
import { BoardProvider, useBoardContext } from "@/providers/board-provider";
import { DialogProvider, useDialogContext } from "@/providers/dialog-provider";
import { GitProvider, useGitContext } from "@/providers/git-provider";
import { InteractionsProvider, useInteractionsContext } from "@/providers/interactions-provider";
import { ProjectProvider, useProjectContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { SurfaceNavigationProvider, useSurfaceNavigationContext } from "@/providers/surface-navigation-provider";
import { TaskEditorProvider, useTaskEditorContext } from "@/providers/task-editor-provider";
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
	searchOverlayResetRef: React.MutableRefObject<() => void>;
}

// ---------------------------------------------------------------------------
// AppEarlyBailout — renders fallback UIs for disconnected/blocked states.
// Must be inside ProjectProvider so it can read useProjectContext().
// ---------------------------------------------------------------------------

function AppEarlyBailout({ children }: { children: ReactNode }): ReactNode {
	const { isRuntimeDisconnected } = useProjectContext();
	const { isQuarterdeckAccessBlocked } = useProjectRuntimeContext();

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
	const { isBlocked, forceOpen } = useSingleTabGuard();
	if (isBlocked) return <AlreadyOpenFallback onForceOpen={forceOpen} />;
	return <AppInner />;
}

function AppInner(): ReactElement {
	const [projectBoardSessions, setProjectBoardSessionsState] = useState<ProjectBoardSessionsState>(() => ({
		board: createInitialBoardData(),
		sessions: {},
	}));
	const [canPersistProjectState, setCanPersistProjectState] = useState(false);
	const projectBoardSessionsRef = useRef(projectBoardSessions);
	const { board, sessions } = projectBoardSessions;

	const setProjectBoardSessions = useCallback((nextState: SetStateAction<ProjectBoardSessionsState>) => {
		const resolved = typeof nextState === "function" ? nextState(projectBoardSessionsRef.current) : nextState;
		// Keep the shared board+sessions ref in lockstep with queued React
		// state so authoritative project apply reads the latest local state
		// instead of stale render-time snapshots.
		projectBoardSessionsRef.current = resolved;
		setProjectBoardSessionsState(resolved);
	}, []);

	const setBoard = useCallback(
		(nextBoard: SetStateAction<BoardData>) => {
			setProjectBoardSessions((current) => ({
				...current,
				board: typeof nextBoard === "function" ? nextBoard(current.board) : nextBoard,
			}));
		},
		[setProjectBoardSessions],
	);

	const setSessions = useCallback(
		(nextSessions: SetStateAction<Record<string, RuntimeTaskSessionSummary>>) => {
			setProjectBoardSessions((current) => ({
				...current,
				sessions: typeof nextSessions === "function" ? nextSessions(current.sessions) : nextSessions,
			}));
		},
		[setProjectBoardSessions],
	);

	const searchOverlayResetRef = useRef<() => void>(() => {});

	const handleProjectSwitchStart = useCallback(() => {
		setCanPersistProjectState(false);
		searchOverlayResetRef.current();
	}, []);

	return (
		<ProjectProvider
			onProjectSwitchStart={handleProjectSwitchStart}
			projectBoardSessionsRef={projectBoardSessionsRef}
			setProjectBoardSessions={setProjectBoardSessions}
			canPersistProjectState={canPersistProjectState}
			setCanPersistProjectState={setCanPersistProjectState}
		>
			<AppEarlyBailout>
				<BoardProvider board={board} setBoard={setBoard} sessions={sessions} setSessions={setSessions}>
					<TaskEditorProvider>
						<SurfaceNavigationProvider>
							<GitProvider>
								<TerminalProvider>
									<InteractionsProvider>
										<DialogProvider>
											<AppContent searchOverlayResetRef={searchOverlayResetRef} />
										</DialogProvider>
									</InteractionsProvider>
								</TerminalProvider>
							</GitProvider>
						</SurfaceNavigationProvider>
					</TaskEditorProvider>
				</BoardProvider>
			</AppEarlyBailout>
		</ProjectProvider>
	);
}

// ---------------------------------------------------------------------------
// AppContent — inner component: rendered inside the provider tree.
// Reads from the provider contexts, runs side-effect hooks, renders all JSX.
// ---------------------------------------------------------------------------

function AppContent({ searchOverlayResetRef }: AppContentProps): ReactElement {
	const project = useProjectContext();
	const projectRuntime = useProjectRuntimeContext();
	const boardContext = useBoardContext();
	const taskEditorContext = useTaskEditorContext();
	const { board, selectedTaskId, selectedCard, setSelectedTaskId, sendTaskSessionInput, isAwaitingProjectSnapshot } =
		boardContext;
	const { taskEditor, createTaskBranchOptions } = taskEditorContext;
	const git = useGitContext();
	const navigation = useSurfaceNavigationContext();
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
			navigation.navigateToFile({ targetView: "files", filePath, lineNumber });
		},
		[navigation.navigateToFile],
	);

	useEffect(() => {
		searchOverlayResetRef.current = () => {
			setIsFileFinderOpen(false);
			setIsTextSearchOpen(false);
		};
	}, [searchOverlayResetRef]);

	// --- Side-effect hooks ---

	useTerminalConfigSync({
		terminalFontWeight: projectRuntime.terminalFontWeight,
	});
	useAppSideEffects({
		project,
		projectRuntime,
		board: boardContext,
		taskEditor: taskEditorContext,
		git,
		navigation,
		terminal,
		interactions,
		dialog,
		serverMutationInFlightRef,
		handleToggleFileFinder,
		handleToggleTextSearch,
	});

	const { runningShortcutLabel, handleSelectShortcutLabel, handleRunShortcut, handleCreateShortcut } =
		useShortcutActions({
			currentProjectId: project.currentProjectId,
			selectedShortcutLabel: projectRuntime.runtimeProjectConfig?.selectedShortcutLabel,
			shortcuts: projectRuntime.shortcuts,
			refreshRuntimeProjectConfig: projectRuntime.refreshRuntimeProjectConfig,
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
		promptShortcuts: projectRuntime.runtimeProjectConfig?.promptShortcuts ?? [],
		refreshRuntimeConfig: projectRuntime.refreshRuntimeProjectConfig,
		sendTaskSessionInput,
	});

	const {
		stableCardActions,
		reactiveCardState,
		handleMainViewChange,
		handleCardSelectWithFocus,
		handleCardDoubleClick,
		handleBack,
		projectsBadgeColor,
		boardBadgeColor,
		detailSession,
	} = useAppActionModels({
		project,
		projectRuntime,
		board: boardContext,
		navigation,
		interactions,
	});

	const { sidebarAreaRef, homeSidePanelPercent, handleHomeSidePanelSeparatorMouseDown } = useHomeSidePanelResize({
		sidePanelRatio: navigation.sidePanelRatio,
		setSidePanelRatio: navigation.setSidePanelRatio,
	});

	const { navbarProjectPath, navbarProjectHint, navbarRuntimeHint, shouldHideProjectDependentTopBarActions } =
		useNavbarState({
			selectedCard,
			selectedTaskWorktreeInfo: selectedTaskWorktreeInfo,
			selectedTaskWorktreeSnapshot: selectedTaskWorktreeSnapshot,
			projectPath: project.projectPath,
			shouldUseNavigationPath: shouldUseNavigationPath,
			navigationProjectPath: navigationProjectPath,
			runtimeProjectConfig: projectRuntime.runtimeProjectConfig,
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
			defaultBaseRef={projectRuntime.configDefaultBaseRef}
			onSetDefaultBaseRef={projectRuntime.handleSetDefaultBaseRef}
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
				<LayoutResetBridge resetToDefaults={navigation.resetSurfaceNavigationToDefaults} />
				<div ref={sidebarAreaRef} className="flex h-[100svh] min-w-0 overflow-hidden">
					{/* Sidebar toolbar + side panel */}
					<>
						<DetailToolbar
							activeMainView={navigation.visualMainView}
							activeSidebar={navigation.visualSidebar}
							onMainViewChange={handleMainViewChange}
							onSidebarChange={navigation.toggleSidebar}
							sidebarPinned={navigation.sidebarPinned}
							onToggleSidebarPinned={navigation.toggleSidebarPinned}
							hasSelectedTask={selectedCard !== null}
							gitBadgeColor={
								selectedCard
									? (selectedTaskWorktreeSnapshot?.changedFiles ?? 0) > 0
										? "red"
										: projectRuntime.unmergedChangesIndicatorEnabled &&
												(selectedTaskWorktreeSnapshot?.hasUnmergedChanges ?? false)
											? "blue"
											: undefined
									: (homeGitSummary?.changedFiles ?? 0) > 0
										? "red"
										: undefined
							}
							isBehindBase={
								projectRuntime.behindBaseIndicatorEnabled && selectedCard
									? (selectedTaskWorktreeSnapshot?.behindBaseCount ?? 0) > 0
									: false
							}
							projectsBadgeColor={projectsBadgeColor}
							boardBadgeColor={selectedCard ? boardBadgeColor : undefined}
						/>

						{navigation.sidebar === "commit" && !selectedCard ? (
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
										navigateToFile={navigation.navigateToFile}
									/>
								</div>
								<ResizeHandle
									orientation="vertical"
									ariaLabel="Resize home side panel"
									onMouseDown={handleHomeSidePanelSeparatorMouseDown}
									className="z-10"
								/>
							</>
						) : navigation.sidebar === "projects" || (navigation.sidebar !== null && !selectedCard) ? (
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
										needsInputByProject={project.needsInputByProject}
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
							layoutProps={{
								mainView: navigation.mainView,
								sidebar: navigation.sidebar,
								topBar,
								sidePanelRatio: navigation.sidePanelRatio,
								setSidePanelRatio: navigation.setSidePanelRatio,
							}}
							sidePanelProps={{
								navigateToFile: navigation.navigateToFile,
								onCardSelect: handleCardSelectWithFocus,
								onCardDoubleClick: handleCardDoubleClick,
								onCreateTask: handleOpenCreateTask,
								onStartAllTasks: interactions.handleStartAllBacklogTasksFromBoard,
								onClearTrash: interactions.handleOpenClearTrash,
								editingTaskId,
								inlineTaskEditor,
								onEditTask: (task) => {
									handleOpenEditTask(task, { preserveDetailSelection: true });
								},
							}}
							repositoryProps={{
								gitHistoryPanel: navigation.isGitHistoryOpen ? (
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
										skipCherryPickConfirmation={projectRuntime.skipCherryPickConfirmation}
									/>
								) : undefined,
								pinnedBranches: projectRuntime.pinnedBranches,
								onTogglePinBranch: projectRuntime.handleTogglePinBranch,
								skipTaskCheckoutConfirmation: projectRuntime.skipTaskCheckoutConfirmation,
								skipHomeCheckoutConfirmation: projectRuntime.skipHomeCheckoutConfirmation,
								onSkipTaskCheckoutConfirmationChange: projectRuntime.handleSkipTaskCheckoutConfirmationChange,
								onDeselectTask: () => setSelectedTaskId(null),
							}}
							terminalProps={{
								bottomTerminalOpen: terminal.isDetailTerminalOpen,
								bottomTerminalTaskId: terminal.detailTerminalTaskId,
								bottomTerminalSummary: terminal.detailTerminalSummary,
								bottomTerminalSubtitle: terminal.detailTerminalSubtitle,
								onBottomTerminalClose: terminal.closeDetailTerminal,
								onBottomTerminalCollapse: terminal.collapseDetailTerminal,
								bottomTerminalPaneHeight: terminal.detailTerminalPaneHeight,
								onBottomTerminalPaneHeightChange: terminal.setDetailTerminalPaneHeight,
								onBottomTerminalConnectionReady: terminal.markTerminalConnectionReady,
								bottomTerminalAgentCommand: projectRuntime.agentCommand,
								onBottomTerminalSendAgentCommand: terminal.handleSendAgentCommandToDetailTerminal,
								isBottomTerminalExpanded: terminal.isDetailTerminalExpanded,
								onBottomTerminalToggleExpand: terminal.handleToggleExpandDetailTerminal,
								onBottomTerminalRestart: terminal.handleRestartDetailTerminal,
								onBottomTerminalExit: terminal.handleShellExit,
							}}
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
					<AppDialogs savePromptShortcuts={savePromptShortcuts} />
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
