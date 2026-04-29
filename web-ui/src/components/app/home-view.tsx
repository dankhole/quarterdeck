import { FolderOpen } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { GitBranchStatusControl } from "@/components/app/top-bar";
import { QuarterdeckBoard } from "@/components/board";
import { ConflictBanner, FilesView, GitHistoryView, GitView } from "@/components/git";
import { BranchPillTrigger, BranchSelectorPopover, ScopeBar } from "@/components/git/panels";
import { ShellTerminalPanel } from "@/components/terminal";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useBoardContext } from "@/providers/board-provider";
import { useGitContext } from "@/providers/git-provider";
import { useInteractionsContext } from "@/providers/interactions-provider";
import { useProjectContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { useSurfaceNavigationContext } from "@/providers/surface-navigation-provider";
import { useTerminalContext } from "@/providers/terminal-provider";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import type { RuntimeGitSyncSummary } from "@/runtime/types";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardCard } from "@/types";

interface HomeViewProps {
	topBar: ReactNode;
	shouldShowProjectLoadingState: boolean;
	editingTaskId: string | null;
	inlineTaskEditor: ReactNode | undefined;
	handleOpenCreateTask: () => void;
	handleOpenEditTask: (task: BoardCard, options?: { preserveDetailSelection?: boolean }) => void;
	homeGitSummary: RuntimeGitSyncSummary | null;
}

export function HomeView({
	topBar,
	shouldShowProjectLoadingState,
	editingTaskId,
	inlineTaskEditor,
	handleOpenCreateTask,
	handleOpenEditTask,
	homeGitSummary,
}: HomeViewProps): ReactElement {
	const project = useProjectContext();
	const projectRuntime = useProjectRuntimeContext();
	const { board, sessions, upsertSession, selectedTaskId } = useBoardContext();
	const git = useGitContext();
	const navigation = useSurfaceNavigationContext();
	const terminal = useTerminalContext();
	const interactions = useInteractionsContext();

	return (
		<div className="flex flex-col flex-1 min-w-0 overflow-hidden">
			{topBar}
			{navigation.mainView !== "git" && (
				<ConflictBanner taskId={selectedTaskId} onNavigateToResolver={navigation.navigateToGitView} />
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
							<p className="text-[13px] text-text-secondary">Add a git repository to start using Quarterdeck.</p>
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
							{navigation.mainView === "git" ? (
								<GitView
									currentProjectId={project.currentProjectId}
									selectedCard={null}
									sessionSummary={null}
									projectPath={project.projectPath}
									homeGitSummary={homeGitSummary}
									board={board}
									pendingCompareNavigation={navigation.pendingCompareNavigation}
									onCompareNavigationConsumed={navigation.clearPendingCompareNavigation}
									pendingFileNavigation={navigation.pendingFileNavigation}
									onFileNavigationConsumed={navigation.clearPendingFileNavigation}
									navigateToFile={navigation.navigateToFile}
									pinnedBranches={projectRuntime.pinnedBranches}
									onTogglePinBranch={projectRuntime.handleTogglePinBranch}
									branchStatusSlot={
										homeGitSummary ? (
											<GitBranchStatusControl
												branchLabel={homeGitSummary.currentBranch ?? "detached HEAD"}
												changedFiles={homeGitSummary.changedFiles ?? 0}
												additions={homeGitSummary.additions ?? 0}
												deletions={homeGitSummary.deletions ?? 0}
												onToggleGitHistory={navigation.handleToggleGitHistory}
												isGitHistoryOpen={navigation.isGitHistoryOpen}
											/>
										) : undefined
									}
									gitHistoryPanel={
										navigation.isGitHistoryOpen ? (
											<GitHistoryView
												projectId={project.currentProjectId}
												gitHistory={git.gitHistory}
												onCheckoutBranch={(branch) => {
													void git.switchHomeBranch(branch);
												}}
												onCreateBranch={git.fileBrowserBranchActions.handleCreateBranchFrom}
												onPullLatest={() => {
													void git.runGitAction("pull");
												}}
												onRebaseBranch={git.fileBrowserBranchActions.handleRebaseBranch}
												onRenameBranch={git.fileBrowserBranchActions.handleRenameBranch}
												onResetToRef={git.fileBrowserBranchActions.handleResetToRef}
												taskScope={git.gitHistoryTaskScope}
												skipCherryPickConfirmation={projectRuntime.skipCherryPickConfirmation}
											/>
										) : undefined
									}
								/>
							) : navigation.mainView === "files" ? (
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
											isDetachedHead={homeGitSummary?.currentBranch === null && homeGitSummary !== null}
											onSwitchToHome={git.fileBrowserSwitchToHome}
											onReturnToContextual={git.fileBrowserReturnToContextual}
											branchPillSlot={
												<BranchSelectorPopover
													isOpen={git.fileBrowserBranchActions.isBranchPopoverOpen}
													onOpenChange={git.fileBrowserBranchActions.setBranchPopoverOpen}
													branches={git.fileBrowserBranchActions.branches}
													currentBranch={git.fileBrowserBranchActions.currentBranch}
													worktreeBranches={git.fileBrowserBranchActions.worktreeBranches}
													onSelectBranchView={git.fileBrowserBranchActions.handleSelectBranchView}
													onCheckoutBranch={git.fileBrowserBranchActions.handleCheckoutBranch}
													onCompareWithBranch={(branch) =>
														navigation.openGitCompare({ targetRef: branch })
													}
													onMergeBranch={git.fileBrowserBranchActions.handleMergeBranch}
													onCreateBranch={git.fileBrowserBranchActions.handleCreateBranchFrom}
													onDeleteBranch={git.fileBrowserBranchActions.handleDeleteBranch}
													onRebaseBranch={git.fileBrowserBranchActions.handleRebaseBranch}
													onRenameBranch={git.fileBrowserBranchActions.handleRenameBranch}
													onResetToRef={git.fileBrowserBranchActions.handleResetToRef}
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
													pinnedBranches={projectRuntime.pinnedBranches}
													onTogglePinBranch={projectRuntime.handleTogglePinBranch}
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
									rootPath={project.projectPath}
									pendingFileNavigation={navigation.pendingFileNavigation}
									onFileNavigationConsumed={navigation.clearPendingFileNavigation}
									scopeKey={`home-${project.currentProjectId ?? "no-project"}`}
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
									<ShellTerminalPanel
										key={`home-shell-${terminal.homeTerminalTaskId}`}
										taskId={terminal.homeTerminalTaskId}
										projectId={project.currentProjectId}
										summary={terminal.homeTerminalSummary}
										onSummary={upsertSession}
										autoFocus
										onClose={terminal.closeHomeTerminal}
										headerTitle="Shell"
										headerSubtitle={terminal.homeTerminalSubtitle}
										panelBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
										terminalBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
										cursorColor={TERMINAL_THEME_COLORS.textPrimary}
										onConnectionReady={terminal.markTerminalConnectionReady}
										launchCommand={projectRuntime.agentCommand}
										onLaunchCommand={terminal.handleSendAgentCommandToHomeTerminal}
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
	);
}
