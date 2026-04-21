import { GitBranchStatusControl } from "@/components/app/top-bar";
import { FilesView, GitView } from "@/components/git";
import { BranchPillTrigger, BranchSelectorPopover, ScopeBar } from "@/components/git/panels";
import type { TaskDetailRepositoryProps } from "@/components/task/task-detail-screen";
import type { CardDetailViewLayoutState, CardDetailViewRepositoryState } from "@/hooks/board/use-card-detail-view";
import type { MainViewId } from "@/resize/use-card-detail-layout";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { CardSelection } from "@/types";

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
					homeGitSummary={repositoryState.homeGitSummary}
					board={repositoryState.board}
					pendingCompareNavigation={repositoryState.pendingCompareNavigation}
					onCompareNavigationConsumed={repositoryState.onCompareNavigationConsumed}
					pendingFileNavigation={repositoryState.pendingFileNavigation}
					onFileNavigationConsumed={repositoryState.onFileNavigationConsumed}
					navigateToFile={repositoryState.navigateToFile}
					branchStatusSlot={
						repositoryState.taskWorktreeInfo || repositoryState.taskWorktreeSnapshot ? (
							<TaskBranchStatus
								branchLabel={
									repositoryState.taskWorktreeInfo?.branch ??
									repositoryState.taskWorktreeSnapshot?.headCommit?.slice(0, 8) ??
									"initializing"
								}
								changedFiles={repositoryState.taskWorktreeSnapshot?.changedFiles ?? 0}
								additions={repositoryState.taskWorktreeSnapshot?.additions ?? 0}
								deletions={repositoryState.taskWorktreeSnapshot?.deletions ?? 0}
								isGitHistoryOpen={repositoryState.isGitHistoryOpen}
								onToggleGitHistory={repositoryState.onToggleGitHistory}
								isDetached={repositoryState.taskWorktreeInfo?.isDetached ?? false}
								baseRef={selection.card.baseRef}
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
					scopeBar={
						<ScopeBar
							resolvedScope={repositoryState.taskResolvedScope}
							scopeMode={repositoryState.taskScopeMode}
							homeGitSummary={repositoryState.homeGitSummary}
							taskTitle={selection.card.title}
							taskBranch={repositoryState.taskWorktreeInfo?.branch ?? selection.card.branch ?? null}
							taskBaseRef={selection.card.baseRef}
							behindBaseCount={repositoryState.taskWorktreeSnapshot?.behindBaseCount ?? null}
							isDetachedHead={repositoryState.taskWorktreeInfo?.isDetached ?? false}
							taskIsDetached={repositoryState.taskWorktreeInfo?.isDetached ?? false}
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
										trigger={<BranchPillTrigger label={repositoryState.pillBranchLabel} />}
									/>
								) : undefined
							}
							onCheckoutBrowsingBranch={checkoutBrowsingBranch}
						/>
					}
					fileBrowserData={repositoryState.fileBrowserData}
					rootPath={repositoryState.taskWorktreeInfo?.path ?? selection.card.workingDirectory}
					pendingFileNavigation={repositoryState.pendingFileNavigation}
					onFileNavigationConsumed={repositoryState.onFileNavigationConsumed}
					scopeKey={`${selection.card.id}-${repositoryState.taskScopeMode}`}
				/>
			)}
		</div>
	);
}
