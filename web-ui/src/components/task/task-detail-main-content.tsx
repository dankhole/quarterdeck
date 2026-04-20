import type { ReactNode } from "react";
import { GitBranchStatusControl } from "@/components/app/top-bar";
import { ConflictBanner, FilesView, GitView } from "@/components/git";
import { BranchPillTrigger, BranchSelectorPopover, ScopeBar } from "@/components/git/panels";
import { AgentTerminalPanel, ShellTerminalPanel } from "@/components/terminal";
import type { UseCardDetailViewResult } from "@/hooks/board/use-card-detail-view";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import type { MainViewId } from "@/resize/use-card-detail-layout";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import { type CardSelection, getTaskAutoReviewCancelButtonLabel } from "@/types";

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

interface TaskDetailMainContentProps {
	// This component intentionally keeps the full detail-view template together;
	// the hook owns workflow state, while this file stays focused on layout/composition.
	detail: UseCardDetailViewResult;
	selection: CardSelection;
	currentProjectId: string | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	mainView: MainViewId;
	topBar: ReactNode;
	gitHistoryPanel?: ReactNode;
	pinnedBranches?: string[];
	onTogglePinBranch?: (branchName: string) => void;
	onDeselectTask: () => void;
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
}

export function TaskDetailMainContent({
	detail,
	selection,
	currentProjectId,
	sessionSummary,
	mainView,
	topBar,
	gitHistoryPanel,
	pinnedBranches,
	onTogglePinBranch,
	onDeselectTask,
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
}: TaskDetailMainContentProps): React.ReactElement {
	const browsingBranchRef = detail.taskResolvedScope?.type === "branch_view" ? detail.taskResolvedScope.ref : null;
	const checkoutBrowsingBranch = browsingBranchRef
		? () => detail.taskBranchActions.handleCheckoutBranch(browsingBranchRef)
		: undefined;
	const cancelAutomaticAction =
		selection.card.autoReviewEnabled === true && detail.onCancelAutomaticTaskAction
			? () => detail.onCancelAutomaticTaskAction?.(selection.card.id)
			: undefined;

	return (
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
				<ConflictBanner taskId={selection.card.id} onNavigateToResolver={detail.navigateToGitView} />
			)}
			{mainView === "git" ? (
				<div ref={detail.mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
					<GitView
						currentProjectId={currentProjectId}
						selectedCard={selection}
						sessionSummary={sessionSummary}
						homeGitSummary={detail.homeGitSummary}
						board={detail.board}
						pendingCompareNavigation={detail.pendingCompareNavigation}
						onCompareNavigationConsumed={detail.onCompareNavigationConsumed}
						pendingFileNavigation={detail.pendingFileNavigation}
						onFileNavigationConsumed={detail.onFileNavigationConsumed}
						navigateToFile={detail.navigateToFile}
						branchStatusSlot={
							detail.taskWorktreeInfo || detail.taskWorktreeSnapshot ? (
								<TaskBranchStatus
									branchLabel={
										detail.taskWorktreeInfo?.branch ??
										detail.taskWorktreeSnapshot?.headCommit?.slice(0, 8) ??
										"initializing"
									}
									changedFiles={detail.taskWorktreeSnapshot?.changedFiles ?? 0}
									additions={detail.taskWorktreeSnapshot?.additions ?? 0}
									deletions={detail.taskWorktreeSnapshot?.deletions ?? 0}
									isGitHistoryOpen={detail.isGitHistoryOpen}
									onToggleGitHistory={detail.onToggleGitHistory}
									isDetached={detail.taskWorktreeInfo?.isDetached ?? false}
									baseRef={selection.card.baseRef}
								/>
							) : undefined
						}
						gitHistoryPanel={gitHistoryPanel}
						pinnedBranches={pinnedBranches}
						onTogglePinBranch={onTogglePinBranch}
						onAddToTerminal={detail.handleAddToTerminal}
						onSendToTerminal={detail.handleSendToTerminal}
					/>
				</div>
			) : mainView === "files" ? (
				<div ref={detail.mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
					<FilesView
						key={`${selection.card.id}-${detail.taskScopeMode}`}
						scopeBar={
							<ScopeBar
								resolvedScope={detail.taskResolvedScope}
								scopeMode={detail.taskScopeMode}
								homeGitSummary={detail.homeGitSummary}
								taskTitle={selection.card.title}
								taskBranch={detail.taskWorktreeInfo?.branch ?? selection.card.branch ?? null}
								taskBaseRef={selection.card.baseRef}
								behindBaseCount={detail.taskWorktreeSnapshot?.behindBaseCount ?? null}
								isDetachedHead={detail.taskWorktreeInfo?.isDetached ?? false}
								taskIsDetached={detail.taskWorktreeInfo?.isDetached ?? false}
								onSwitchToHome={onDeselectTask}
								onReturnToContextual={detail.taskReturnToContextual}
								branchPillSlot={
									detail.pillBranchLabel ? (
										<BranchSelectorPopover
											isOpen={detail.taskBranchActions.isBranchPopoverOpen}
											onOpenChange={detail.taskBranchActions.setBranchPopoverOpen}
											branches={detail.taskBranchActions.branches}
											currentBranch={detail.taskBranchActions.currentBranch}
											worktreeBranches={detail.taskBranchActions.worktreeBranches}
											onSelectBranchView={detail.taskBranchActions.handleSelectBranchView}
											onCheckoutBranch={detail.taskBranchActions.handleCheckoutBranch}
											onCompareWithBranch={(branch) => detail.onOpenGitCompare({ targetRef: branch })}
											onMergeBranch={detail.taskBranchActions.handleMergeBranch}
											onCreateBranch={detail.taskBranchActions.handleCreateBranchFrom}
											onDeleteBranch={detail.taskBranchActions.handleDeleteBranch}
											onPull={(branch) => {
												void detail.runGitAction(
													"pull",
													{ taskId: selection.card.id, baseRef: selection.card.baseRef },
													branch,
												);
											}}
											onPush={(branch) => {
												void detail.runGitAction(
													"push",
													{ taskId: selection.card.id, baseRef: selection.card.baseRef },
													branch,
												);
											}}
											pinnedBranches={pinnedBranches}
											onTogglePinBranch={onTogglePinBranch}
											trigger={<BranchPillTrigger label={detail.pillBranchLabel} />}
										/>
									) : undefined
								}
								onCheckoutBrowsingBranch={checkoutBrowsingBranch}
							/>
						}
						fileBrowserData={detail.fileBrowserData}
						rootPath={detail.taskWorktreeInfo?.path ?? selection.card.workingDirectory}
						pendingFileNavigation={detail.pendingFileNavigation}
						onFileNavigationConsumed={detail.onFileNavigationConsumed}
						scopeKey={`${selection.card.id}-${detail.taskScopeMode}`}
					/>
				</div>
			) : (
				<>
					<div
						ref={detail.mainRowRef}
						style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}
					>
						<div style={{ display: "flex", flex: "1 1 0", minWidth: 0, minHeight: 0 }}>
							<AgentTerminalPanel
								taskId={selection.card.id}
								projectId={currentProjectId}
								terminalEnabled={detail.isTaskTerminalEnabled}
								summary={sessionSummary}
								onSummary={detail.onSessionSummary}
								showSessionToolbar={false}
								autoFocus
								onCancelAutomaticAction={cancelAutomaticAction}
								cancelAutomaticActionLabel={
									selection.card.autoReviewEnabled === true
										? getTaskAutoReviewCancelButtonLabel(selection.card.autoReviewMode)
										: null
								}
								panelBackgroundColor={TERMINAL_THEME_COLORS.surfacePrimary}
								terminalBackgroundColor={TERMINAL_THEME_COLORS.surfacePrimary}
								taskColumnId={selection.column.id}
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
								<ShellTerminalPanel
									key={`detail-shell-${bottomTerminalTaskId}`}
									taskId={bottomTerminalTaskId}
									projectId={currentProjectId}
									summary={bottomTerminalSummary}
									onSummary={detail.onSessionSummary}
									autoFocus
									onClose={onBottomTerminalClose}
									headerTitle="Shell"
									headerSubtitle={bottomTerminalSubtitle}
									panelBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
									terminalBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
									cursorColor={TERMINAL_THEME_COLORS.textPrimary}
									onConnectionReady={onBottomTerminalConnectionReady}
									launchCommand={bottomTerminalAgentCommand}
									onLaunchCommand={onBottomTerminalSendAgentCommand}
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
	);
}
