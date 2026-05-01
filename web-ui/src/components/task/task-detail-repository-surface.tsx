import { Info } from "lucide-react";
import { GitBranchStatusControl } from "@/components/app/top-bar";
import { FilesView, GitView } from "@/components/git";
import { BranchPillTrigger, BranchSelectorPopover, ScopeBar } from "@/components/git/panels";
import type { TaskDetailRepositoryProps } from "@/components/task/task-detail-screen";
import { Tooltip } from "@/components/ui/tooltip";
import type { CardDetailViewLayoutState, CardDetailViewRepositoryState } from "@/hooks/board/use-card-detail-view";
import type { MainViewId } from "@/resize/use-card-detail-layout";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getProjectPath } from "@/stores/project-metadata-store";
import type { CardSelection } from "@/types";
import { type DetachedWorktreeDisplayState, resolveDetachedTaskWorktreeDisplay } from "@/utils/task-base-ref-display";
import { resolveTaskGitState } from "@/utils/task-git-state";

function TaskBranchStatus({
	branchLabel,
	changedFiles,
	additions,
	deletions,
	isGitHistoryOpen,
	onToggleGitHistory,
	detachedWorktree,
}: {
	branchLabel: string;
	changedFiles: number;
	additions: number;
	deletions: number;
	isGitHistoryOpen: boolean;
	onToggleGitHistory?: () => void;
	detachedWorktree: DetachedWorktreeDisplayState | null;
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
			{detachedWorktree ? (
				<Tooltip content={detachedWorktree.tooltip} side="bottom">
					<span className="inline-flex items-center gap-1 text-xs text-text-tertiary whitespace-nowrap ml-1">
						<Info size={11} className="text-text-tertiary" />
						<span>{detachedWorktree.label}</span>
					</span>
				</Tooltip>
			) : null}
		</div>
	);
}

interface TaskDetailRepositorySurfaceProps {
	detailLayout: CardDetailViewLayoutState;
	repositoryState: CardDetailViewRepositoryState;
	repositoryProps: TaskDetailRepositoryProps;
	selection: CardSelection;
	currentProjectId: string | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	mainView: Extract<MainViewId, "files" | "git">;
}

export function TaskDetailRepositorySurface({
	detailLayout,
	repositoryState,
	repositoryProps,
	selection,
	currentProjectId,
	sessionSummary,
	mainView,
}: TaskDetailRepositorySurfaceProps): React.ReactElement {
	const browsingBranchRef =
		repositoryState.taskResolvedScope?.type === "branch_view" ? repositoryState.taskResolvedScope.ref : null;
	const checkoutBrowsingBranch = browsingBranchRef
		? () => repositoryState.taskBranchActions.handleCheckoutBranch(browsingBranchRef)
		: undefined;
	const projectPath = getProjectPath();
	const taskGitState = resolveTaskGitState({
		projectRootPath: projectPath,
		card: selection.card,
		repositoryInfo: repositoryState.taskRepositoryInfo,
		worktreeSnapshot: repositoryState.taskWorktreeSnapshot,
		homeGitSummary: repositoryState.homeGitSummary,
		sessionSummary,
	});
	const taskIdentity = taskGitState.identity;
	const detachedWorktree = resolveDetachedTaskWorktreeDisplay({
		isDetached: taskGitState.isDetached,
		isAssignedShared: taskIdentity.isAssignedShared,
		baseRef: selection.card.baseRef,
		headCommit: taskIdentity.assignedHeadCommit,
	});
	const isDetachedTaskWorktree = detachedWorktree !== null;
	const showDetachedPillHint = detachedWorktree !== null && repositoryState.taskResolvedScope?.type !== "branch_view";

	return (
		<div
			ref={detailLayout.mainRowRef}
			style={{
				display: "flex",
				flex: "1 1 0",
				minHeight: 0,
				overflow: "hidden",
			}}
		>
			{mainView === "git" ? (
				<GitView
					currentProjectId={currentProjectId}
					selectedCard={selection}
					sessionSummary={sessionSummary}
					projectPath={projectPath}
					homeGitSummary={repositoryState.homeGitSummary}
					board={repositoryState.board}
					pendingCompareNavigation={repositoryState.pendingCompareNavigation}
					onCompareNavigationConsumed={repositoryState.onCompareNavigationConsumed}
					pendingFileNavigation={repositoryState.pendingFileNavigation}
					onFileNavigationConsumed={repositoryState.onFileNavigationConsumed}
					navigateToFile={repositoryState.navigateToFile}
					branchStatusSlot={
						taskGitState.hasRepositoryMetadata ? (
							<TaskBranchStatus
								branchLabel={taskGitState.branchLabel ?? "initializing"}
								changedFiles={taskGitState.changedFiles}
								additions={taskGitState.additions}
								deletions={taskGitState.deletions}
								isGitHistoryOpen={repositoryState.isGitHistoryOpen}
								onToggleGitHistory={repositoryState.onToggleGitHistory}
								detachedWorktree={detachedWorktree}
							/>
						) : undefined
					}
					gitHistoryPanel={repositoryProps.gitHistoryPanel}
					pinnedBranches={repositoryProps.pinnedBranches}
					onTogglePinBranch={repositoryProps.onTogglePinBranch}
					onAddToTerminal={repositoryState.handleAddToTerminal}
					onSendToTerminal={repositoryState.handleSendToTerminal}
				/>
			) : (
				<FilesView
					key={`${selection.card.id}-${repositoryState.taskScopeMode}`}
					showScopeBar={repositoryState.taskScopeMode !== "contextual"}
					scopeBar={
						<ScopeBar
							resolvedScope={repositoryState.taskResolvedScope}
							scopeMode={repositoryState.taskScopeMode}
							homeGitSummary={repositoryState.homeGitSummary}
							taskTitle={selection.card.title}
							taskBranch={taskGitState.branch}
							taskBaseRef={selection.card.baseRef}
							behindBaseCount={taskGitState.behindBaseCount}
							isDetachedHead={
								repositoryState.homeGitSummary !== null && repositoryState.homeGitSummary.currentBranch === null
							}
							taskIsDetached={isDetachedTaskWorktree}
							onSwitchToHome={repositoryProps.onDeselectTask}
							onReturnToContextual={repositoryState.taskReturnToContextual}
							branchPillSlot={
								repositoryState.pillBranchLabel ? (
									<BranchSelectorPopover
										isOpen={repositoryState.taskBranchActions.isBranchPopoverOpen}
										onOpenChange={repositoryState.taskBranchActions.setBranchPopoverOpen}
										branches={repositoryState.taskBranchActions.branches}
										currentBranch={repositoryState.taskBranchActions.currentBranch}
										worktreeBranches={repositoryState.taskBranchActions.worktreeBranches}
										onSelectBranchView={repositoryState.taskBranchActions.handleSelectBranchView}
										onCheckoutBranch={repositoryState.taskBranchActions.handleCheckoutBranch}
										onCompareWithBranch={(branch) => repositoryState.onOpenGitCompare({ targetRef: branch })}
										onMergeBranch={repositoryState.taskBranchActions.handleMergeBranch}
										onCreateBranch={repositoryState.taskBranchActions.handleCreateBranchFrom}
										onDeleteBranch={repositoryState.taskBranchActions.handleDeleteBranch}
										onPull={(branch) => {
											void repositoryState.runGitAction(
												"pull",
												{ taskId: selection.card.id, baseRef: selection.card.baseRef },
												branch,
											);
										}}
										onPush={(branch) => {
											void repositoryState.runGitAction(
												"push",
												{ taskId: selection.card.id, baseRef: selection.card.baseRef },
												branch,
											);
										}}
										pinnedBranches={repositoryProps.pinnedBranches}
										onTogglePinBranch={repositoryProps.onTogglePinBranch}
										detachedWorktreeBaseRef={detachedWorktree?.baseRef}
										detachedWorktreeHeadCommit={detachedWorktree?.headCommit}
										trigger={
											<BranchPillTrigger
												label={repositoryState.pillBranchLabel}
												detachedWorktreeBaseRef={
													showDetachedPillHint ? detachedWorktree.baseRef : undefined
												}
												detachedWorktreeHeadCommit={
													showDetachedPillHint ? detachedWorktree.headCommit : undefined
												}
											/>
										}
									/>
								) : undefined
							}
							onCheckoutBrowsingBranch={checkoutBrowsingBranch}
						/>
					}
					fileBrowserData={repositoryState.fileBrowserData}
					fileEditorAutosaveMode={repositoryProps.fileEditorAutosaveMode}
					rootPath={taskIdentity.assignedPath ?? undefined}
					pendingFileNavigation={repositoryState.pendingFileNavigation}
					onFileNavigationConsumed={repositoryState.onFileNavigationConsumed}
					scopeKey={`${selection.card.id}-${repositoryState.taskScopeMode}`}
				/>
			)}
		</div>
	);
}
