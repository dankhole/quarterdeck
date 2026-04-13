import type { DropResult } from "@hello-pangea/dnd";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useMemo, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { ConflictBanner } from "@/components/conflict-banner";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { BranchPillTrigger, BranchSelectorPopover } from "@/components/detail-panels/branch-selector-popover";
import { CheckoutConfirmationDialog } from "@/components/detail-panels/checkout-confirmation-dialog";
import { ColumnContextPanel } from "@/components/detail-panels/column-context-panel";
import { CommitPanel } from "@/components/detail-panels/commit-panel";
import { CreateBranchDialog } from "@/components/detail-panels/create-branch-dialog";
import { DeleteBranchDialog } from "@/components/detail-panels/delete-branch-dialog";
import { MergeBranchDialog } from "@/components/detail-panels/merge-branch-dialog";
import { ScopeBar } from "@/components/detail-panels/scope-bar";
import { FilesView } from "@/components/files-view";
import { GitView } from "@/components/git-view";
import { GitBranchStatusControl } from "@/components/top-bar";
import { useBranchActions } from "@/hooks/use-branch-actions";
import { useFileBrowserData } from "@/hooks/use-file-browser-data";
import type { GitViewCompareNavigation } from "@/hooks/use-git-view-compare";
import { useScopeContext } from "@/hooks/use-scope-context";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import { ResizeHandle } from "@/resize/resize-handle";
import type { MainViewId, SidebarId } from "@/resize/use-card-detail-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useStableCardActions } from "@/state/card-actions-context";
import {
	useHomeGitSummaryValue,
	useTaskWorkspaceInfoValue,
	useTaskWorkspaceSnapshotValue,
} from "@/stores/workspace-metadata-store";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import { type BoardCard, type BoardData, type CardSelection, getTaskAutoReviewCancelButtonLabel } from "@/types";

/** Branch status slot for the task context git view tab bar. */
function TaskBranchStatus({
	branchLabel,
	changedFiles,
	additions,
	deletions,
	isGitHistoryOpen,
	onToggleGitHistory,
	isDetached,
	baseRef,
}: {
	branchLabel: string;
	changedFiles: number;
	additions: number;
	deletions: number;
	isGitHistoryOpen: boolean;
	onToggleGitHistory?: () => void;
	isDetached: boolean;
	baseRef: string | null | undefined;
}): React.ReactElement {
	return (
		<div className="flex items-center gap-1">
			<GitBranchStatusControl
				branchLabel={branchLabel}
				changedFiles={changedFiles}
				additions={additions}
				deletions={deletions}
				onToggleGitHistory={onToggleGitHistory}
				isGitHistoryOpen={isGitHistoryOpen}
			/>
			{isDetached && baseRef ? (
				<span className="text-xs text-text-tertiary whitespace-nowrap ml-1">
					based on <span className="font-mono">{baseRef}</span>
				</span>
			) : null}
		</div>
	);
}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/**
 * Renders the task detail area: side panel (for task-tied tabs) + right column (TopBar + main content).
 * Returns a Fragment — its children are direct flex items of the parent container.
 * The sidebar toolbar is NOT rendered here — it lives in App.tsx.
 */
export function CardDetailView({
	selection,
	currentProjectId,
	sessionSummary,
	taskSessions,
	onSessionSummary,
	onCardSelect,
	onTaskDragEnd,
	onCreateTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	gitHistoryPanel,
	isGitHistoryOpen,
	onToggleGitHistory,
	bottomTerminalOpen,
	bottomTerminalTaskId,
	bottomTerminalSummary,
	bottomTerminalSubtitle,
	onBottomTerminalClose,
	onBottomTerminalCollapse,
	bottomTerminalPaneHeight,
	onBottomTerminalPaneHeightChange,
	onBottomTerminalConnectionReady,
	bottomTerminalAgentCommand,
	onBottomTerminalSendAgentCommand,
	isBottomTerminalExpanded,
	onBottomTerminalToggleExpand,
	onBottomTerminalRestart,
	onBottomTerminalExit,
	// --- New props for sidebar decoupling ---
	mainView,
	sidebar,
	topBar,
	sidePanelRatio,
	setSidePanelRatio,
	board,
	skipTaskCheckoutConfirmation,
	skipHomeCheckoutConfirmation,
	onSkipTaskCheckoutConfirmationChange,
	onDeselectTask,
	pendingCompareNavigation,
	onCompareNavigationConsumed,
	onOpenGitCompare,
	pendingFileNavigation,
	onFileNavigationConsumed,
	navigateToFile,
	onCardDoubleClick,
	pinnedBranches,
	onTogglePinBranch,
	onConflictDetected,
	onPullBranch,
	onPushBranch,
}: {
	selection: CardSelection;
	currentProjectId: string | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onSessionSummary: (summary: RuntimeTaskSessionSummary) => void;
	onCardSelect: (taskId: string) => void;
	onCardDoubleClick?: (taskId: string) => void;
	onTaskDragEnd: (result: DropResult) => void;
	onCreateTask?: () => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCard) => void;
	gitHistoryPanel?: ReactNode;
	isGitHistoryOpen?: boolean;
	onToggleGitHistory?: () => void;
	bottomTerminalOpen: boolean;
	bottomTerminalTaskId: string | null;
	bottomTerminalSummary: RuntimeTaskSessionSummary | null;
	bottomTerminalSubtitle?: string | null;
	onBottomTerminalClose: () => void;
	onBottomTerminalCollapse?: () => void;
	bottomTerminalPaneHeight?: number;
	onBottomTerminalPaneHeightChange?: (height: number) => void;
	onBottomTerminalConnectionReady?: (taskId: string) => void;
	bottomTerminalAgentCommand?: string | null;
	onBottomTerminalSendAgentCommand?: () => void;
	isBottomTerminalExpanded?: boolean;
	onBottomTerminalToggleExpand?: () => void;
	onBottomTerminalRestart?: () => void;
	onBottomTerminalExit?: (taskId: string, exitCode: number | null) => void;
	// --- New props ---
	mainView: MainViewId;
	sidebar: SidebarId | null;
	topBar: ReactNode;
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
	board: BoardData;
	skipTaskCheckoutConfirmation: boolean;
	skipHomeCheckoutConfirmation: boolean;
	onSkipTaskCheckoutConfirmationChange?: (skip: boolean) => void;
	onDeselectTask: () => void;
	pendingCompareNavigation?: GitViewCompareNavigation | null;
	onCompareNavigationConsumed?: () => void;
	onOpenGitCompare?: (navigation: GitViewCompareNavigation) => void;
	pendingFileNavigation?: { targetView: "git" | "files"; filePath: string } | null;
	onFileNavigationConsumed?: () => void;
	navigateToFile?: (nav: { targetView: "git" | "files"; filePath: string }) => void;
	pinnedBranches?: string[];
	onTogglePinBranch?: (branchName: string) => void;
	onConflictDetected?: () => void;
	/** Pull current branch from remote. Called with the task scope for worktree-scoped pull. */
	onPullBranch?: () => void;
	/** Push current branch to remote. Called with the task scope for worktree-scoped push. */
	onPushBranch?: () => void;
}): React.ReactElement {
	const { startDrag: startSidePanelResize } = useResizeDrag();
	const { onCancelAutomaticTaskAction } = useStableCardActions();
	const detailLayoutRef = useRef<HTMLDivElement | null>(null);
	const mainRowRef = useRef<HTMLDivElement | null>(null);

	const handleSidePanelSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = detailLayoutRef.current;
			if (!container) return;
			// No toolbar subtraction — toolbar is rendered by App.tsx outside this component
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startRatio = sidePanelRatio;
			startSidePanelResize(event, {
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
		[setSidePanelRatio, startSidePanelResize, sidePanelRatio],
	);

	const taskWorkspaceInfo = useTaskWorkspaceInfoValue(selection.card.id, selection.card.baseRef);
	const taskWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(selection.card.id);
	const homeGitSummary = useHomeGitSummaryValue();

	const {
		scopeMode: taskScopeMode,
		resolvedScope: taskResolvedScope,
		returnToContextual: taskReturnToContextual,
		selectBranchView: taskSelectBranchView,
	} = useScopeContext({
		selectedTaskId: selection.card.id,
		selectedCard: selection.card,
		currentProjectId,
	});

	const taskBranchActions = useBranchActions({
		workspaceId: currentProjectId,
		board,
		selectBranchView: taskSelectBranchView,
		homeGitSummary,
		taskBranch: taskWorkspaceInfo?.branch ?? selection.card.branch ?? null,
		taskChangedFiles: taskWorkspaceSnapshot?.changedFiles ?? 0,
		skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation,
		taskId: selection.card.id,
		baseRef: selection.card.baseRef,
		onCheckoutSuccess: taskReturnToContextual,
		onConflictDetected,
	});

	// Derive what the file browser should show based on scope
	const fileBrowserTaskId = taskResolvedScope?.type === "task" ? taskResolvedScope.taskId : null;
	const fileBrowserBaseRef = taskResolvedScope?.type === "task" ? taskResolvedScope.baseRef : undefined;
	const fileBrowserRef = taskResolvedScope?.type === "branch_view" ? taskResolvedScope.ref : undefined;

	const fileBrowserData = useFileBrowserData({
		workspaceId: currentProjectId,
		taskId: fileBrowserTaskId,
		baseRef: fileBrowserBaseRef,
		ref: fileBrowserRef,
	});

	// Branch pill label: branch name for named-branch worktrees, short commit hash for headless,
	// browsed ref for branch_view. Null only when workspace info hasn't loaded yet (genuinely initializing).
	const pillBranchLabel = useMemo(() => {
		if (taskResolvedScope?.type === "branch_view") {
			return taskResolvedScope.ref;
		}
		if (taskWorkspaceInfo?.branch) return taskWorkspaceInfo.branch;
		// When workspace info reports detached HEAD, skip stale card.branch and show commit hash
		if (taskWorkspaceInfo?.isDetached) return taskWorkspaceInfo.headCommit?.substring(0, 7) ?? null;
		return selection.card.branch ?? taskWorkspaceInfo?.headCommit?.substring(0, 7) ?? null;
	}, [taskResolvedScope, taskWorkspaceInfo, selection.card.branch]);

	const sidePanelPercent = `${(sidePanelRatio * 100).toFixed(1)}%`;
	const isTaskSidePanelOpen = sidebar === "task_column" || sidebar === "commit";
	const isTaskTerminalEnabled = selection.column.id === "in_progress" || selection.column.id === "review";

	const handleSelectAdjacentCard = useCallback(
		(step: number) => {
			const cards = selection.column.cards;
			const currentIndex = cards.findIndex((card) => card.id === selection.card.id);
			if (currentIndex === -1) return;
			const nextIndex = (currentIndex + step + cards.length) % cards.length;
			const nextCard = cards[nextIndex];
			if (nextCard) onCardSelect(nextCard.id);
		},
		[onCardSelect, selection.card.id, selection.column.cards],
	);

	useHotkeys(
		"up,left",
		() => handleSelectAdjacentCard(-1),
		{ ignoreEventWhen: (event) => isTypingTarget(event.target), preventDefault: true },
		[handleSelectAdjacentCard],
	);

	useHotkeys(
		"down,right",
		() => handleSelectAdjacentCard(1),
		{ ignoreEventWhen: (event) => isTypingTarget(event.target), preventDefault: true },
		[handleSelectAdjacentCard],
	);

	// The component renders as a wrapper div whose children are the side panel + right column.
	// The wrapper is a flex row that fills the parent container.
	return (
		<div
			ref={detailLayoutRef}
			style={{
				display: "flex",
				flex: "1 1 0",
				minHeight: 0,
				overflow: "hidden",
				background: "var(--color-surface-0)",
			}}
		>
			{/* Task-tied side panel — only when a task tab is active */}
			{isTaskSidePanelOpen ? (
				<>
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							flex: `0 0 ${sidePanelPercent}`,
							minWidth: 0,
							minHeight: 0,
							overflow: "hidden",
						}}
					>
						{sidebar === "commit" ? (
							<CommitPanel
								workspaceId={currentProjectId ?? ""}
								taskId={selection.card.id}
								baseRef={selection.card.baseRef}
								navigateToFile={navigateToFile}
							/>
						) : (
							<ColumnContextPanel
								selection={selection}
								onCardSelect={onCardSelect}
								onCardDoubleClick={onCardDoubleClick}
								taskSessions={taskSessions}
								onTaskDragEnd={onTaskDragEnd}
								onCreateTask={onCreateTask}
								onStartAllTasks={onStartAllTasks}
								onClearTrash={onClearTrash}
								editingTaskId={editingTaskId}
								inlineTaskEditor={inlineTaskEditor}
								onEditTask={onEditTask}
								panelWidth="100%"
							/>
						)}
					</div>
					<ResizeHandle
						orientation="vertical"
						ariaLabel="Resize side panel"
						onMouseDown={handleSidePanelSeparatorMouseDown}
						className="z-10"
					/>
				</>
			) : null}

			{/* Right column — TopBar + main content */}
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					flex: "1 1 0",
					minWidth: 0,
					minHeight: 0,
					overflow: "hidden",
				}}
			>
				{topBar}
				{mainView !== "git" && (
					<ConflictBanner taskId={selection.card.id} onNavigateToResolver={() => onConflictDetected?.()} />
				)}
				{mainView === "git" ? (
					<div ref={mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
						<GitView
							currentProjectId={currentProjectId}
							selectedCard={selection}
							sessionSummary={sessionSummary}
							homeGitSummary={homeGitSummary}
							board={board}
							pendingCompareNavigation={pendingCompareNavigation}
							onCompareNavigationConsumed={onCompareNavigationConsumed}
							pendingFileNavigation={pendingFileNavigation}
							onFileNavigationConsumed={onFileNavigationConsumed}
							branchStatusSlot={
								taskWorkspaceInfo || taskWorkspaceSnapshot ? (
									<TaskBranchStatus
										branchLabel={
											taskWorkspaceInfo?.branch ??
											taskWorkspaceSnapshot?.headCommit?.slice(0, 8) ??
											"initializing"
										}
										changedFiles={taskWorkspaceSnapshot?.changedFiles ?? 0}
										additions={taskWorkspaceSnapshot?.additions ?? 0}
										deletions={taskWorkspaceSnapshot?.deletions ?? 0}
										isGitHistoryOpen={isGitHistoryOpen ?? false}
										onToggleGitHistory={onToggleGitHistory}
										isDetached={taskWorkspaceInfo?.isDetached ?? false}
										baseRef={selection.card.baseRef}
									/>
								) : undefined
							}
							gitHistoryPanel={gitHistoryPanel}
						/>
					</div>
				) : mainView === "files" ? (
					<div ref={mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
						<FilesView
							key={`${selection.card.id}-${taskScopeMode}`}
							scopeBar={
								<ScopeBar
									resolvedScope={taskResolvedScope}
									scopeMode={taskScopeMode}
									homeGitSummary={homeGitSummary}
									taskTitle={selection.card.title}
									taskBranch={taskWorkspaceInfo?.branch ?? selection.card.branch ?? null}
									taskBaseRef={selection.card.baseRef}
									behindBaseCount={taskWorkspaceSnapshot?.behindBaseCount ?? null}
									isDetachedHead={taskWorkspaceInfo?.isDetached ?? false}
									taskIsDetached={taskWorkspaceInfo?.isDetached ?? false}
									onSwitchToHome={onDeselectTask}
									onReturnToContextual={taskReturnToContextual}
									branchPillSlot={
										pillBranchLabel ? (
											<BranchSelectorPopover
												isOpen={taskBranchActions.isBranchPopoverOpen}
												onOpenChange={taskBranchActions.setBranchPopoverOpen}
												branches={taskBranchActions.branches}
												currentBranch={taskBranchActions.currentBranch}
												worktreeBranches={taskBranchActions.worktreeBranches}
												onSelectBranchView={taskBranchActions.handleSelectBranchView}
												onCheckoutBranch={taskBranchActions.handleCheckoutBranch}
												onCompareWithBranch={
													onOpenGitCompare
														? (branch) => onOpenGitCompare({ targetRef: branch })
														: undefined
												}
												onMergeBranch={taskBranchActions.handleMergeBranch}
												onCreateBranch={taskBranchActions.handleCreateBranchFrom}
												onDeleteBranch={taskBranchActions.handleDeleteBranch}
												onPull={onPullBranch}
												onPush={onPushBranch}
												pinnedBranches={pinnedBranches}
												onTogglePinBranch={onTogglePinBranch}
												trigger={<BranchPillTrigger label={pillBranchLabel} />}
											/>
										) : undefined
									}
									onCheckoutBrowsingBranch={
										taskResolvedScope?.type === "branch_view"
											? () => taskBranchActions.handleCheckoutBranch(taskResolvedScope.ref)
											: undefined
									}
								/>
							}
							fileBrowserData={fileBrowserData}
							rootPath={taskWorkspaceInfo?.path ?? selection.card.workingDirectory}
							pendingFileNavigation={pendingFileNavigation}
							onFileNavigationConsumed={onFileNavigationConsumed}
						/>
					</div>
				) : (
					<>
						<div ref={mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
							<div style={{ display: "flex", flex: "1 1 0", minWidth: 0, minHeight: 0 }}>
								<AgentTerminalPanel
									taskId={selection.card.id}
									workspaceId={currentProjectId}
									terminalEnabled={isTaskTerminalEnabled}
									summary={sessionSummary}
									onSummary={onSessionSummary}
									showSessionToolbar={false}
									autoFocus
									onCancelAutomaticAction={
										selection.card.autoReviewEnabled === true && onCancelAutomaticTaskAction
											? () => onCancelAutomaticTaskAction(selection.card.id)
											: undefined
									}
									cancelAutomaticActionLabel={
										selection.card.autoReviewEnabled === true
											? getTaskAutoReviewCancelButtonLabel(selection.card.autoReviewMode)
											: null
									}
									panelBackgroundColor={TERMINAL_THEME_COLORS.surfacePrimary}
									terminalBackgroundColor={TERMINAL_THEME_COLORS.surfacePrimary}
									taskColumnId={selection.column.id}
									scrollOnEraseInDisplay={false}
								/>
							</div>
						</div>
						{bottomTerminalOpen && bottomTerminalTaskId ? (
							<ResizableBottomPane
								minHeight={200}
								initialHeight={bottomTerminalPaneHeight}
								onHeightChange={onBottomTerminalPaneHeightChange}
								onCollapse={onBottomTerminalCollapse}
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
										key={`detail-shell-${bottomTerminalTaskId}`}
										taskId={bottomTerminalTaskId}
										workspaceId={currentProjectId}
										summary={bottomTerminalSummary}
										onSummary={onSessionSummary}
										showSessionToolbar={false}
										autoFocus
										onClose={onBottomTerminalClose}
										minimalHeaderTitle="Terminal"
										minimalHeaderSubtitle={bottomTerminalSubtitle}
										panelBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
										terminalBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
										cursorColor={TERMINAL_THEME_COLORS.textPrimary}
										onConnectionReady={onBottomTerminalConnectionReady}
										agentCommand={bottomTerminalAgentCommand}
										onSendAgentCommand={onBottomTerminalSendAgentCommand}
										isExpanded={isBottomTerminalExpanded}
										onToggleExpand={onBottomTerminalToggleExpand}
										onRestart={onBottomTerminalRestart}
										onExit={onBottomTerminalExit}
									/>
								</div>
							</ResizableBottomPane>
						) : null}
					</>
				)}
			</div>
			<CheckoutConfirmationDialog
				state={taskBranchActions.checkoutDialogState}
				onClose={taskBranchActions.closeCheckoutDialog}
				onConfirmCheckout={taskBranchActions.handleConfirmCheckout}
				onSkipTaskConfirmationChange={onSkipTaskCheckoutConfirmationChange}
				onStashAndCheckout={taskBranchActions.handleStashAndCheckout}
				isStashingAndCheckingOut={taskBranchActions.isStashingAndCheckingOut}
			/>
			<CreateBranchDialog
				state={taskBranchActions.createBranchDialogState}
				workspaceId={currentProjectId}
				onClose={taskBranchActions.closeCreateBranchDialog}
				onBranchCreated={taskBranchActions.handleBranchCreated}
			/>
			<DeleteBranchDialog
				open={taskBranchActions.deleteBranchDialogState.type === "open"}
				branchName={
					taskBranchActions.deleteBranchDialogState.type === "open"
						? taskBranchActions.deleteBranchDialogState.branchName
						: ""
				}
				onCancel={taskBranchActions.closeDeleteBranchDialog}
				onConfirm={taskBranchActions.handleConfirmDeleteBranch}
			/>
			<MergeBranchDialog
				open={taskBranchActions.mergeBranchDialogState.type === "open"}
				branchName={
					taskBranchActions.mergeBranchDialogState.type === "open"
						? taskBranchActions.mergeBranchDialogState.branchName
						: ""
				}
				currentBranch={taskBranchActions.currentBranch ?? "current branch"}
				onCancel={taskBranchActions.closeMergeBranchDialog}
				onConfirm={taskBranchActions.handleConfirmMergeBranch}
			/>
		</div>
	);
}
