import { ArrowDown, ArrowUp, CircleArrowDown } from "lucide-react";
import type { ReactElement } from "react";
import { BranchPillTrigger, BranchSelectorPopover } from "@/components/detail-panels/branch-selector-popover";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useBoardContext } from "@/providers/board-provider";
import { useDialogContext } from "@/providers/dialog-provider";
import { useGitContext } from "@/providers/git-provider";
import { useProjectContext } from "@/providers/project-provider";
import { useTerminalContext } from "@/providers/terminal-provider";
import type { PromptShortcut, RuntimeGitSyncSummary, RuntimeProjectShortcut } from "@/runtime/types";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

interface ConnectedTopBarProps {
	onBack: (() => void) | undefined;
	runningShortcutLabel: string | null;
	handleSelectShortcutLabel: (shortcutLabel: string) => void;
	handleRunShortcut: (shortcutLabel: string) => Promise<void>;
	handleCreateShortcut: (shortcut: RuntimeProjectShortcut) => Promise<{ ok: boolean; message?: string }>;
	activePromptShortcut: PromptShortcut | null;
	isPromptShortcutRunning: boolean;
	runPromptShortcut: (taskId: string, shortcutLabel: string) => Promise<void>;
	selectPromptShortcutLabel: (label: string) => void;
	navbarWorkspacePath: string | undefined;
	navbarWorkspaceHint: string | undefined;
	navbarRuntimeHint: string | undefined;
	shouldHideProjectDependentTopBarActions: boolean;
	shouldShowProjectLoadingState: boolean;
	homeGitSummary: RuntimeGitSyncSummary | null;
	selectedTaskWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot | null;
}

export function ConnectedTopBar({
	onBack,
	runningShortcutLabel,
	handleSelectShortcutLabel,
	handleRunShortcut,
	handleCreateShortcut,
	activePromptShortcut,
	isPromptShortcutRunning,
	runPromptShortcut,
	selectPromptShortcutLabel,
	navbarWorkspacePath,
	navbarWorkspaceHint,
	navbarRuntimeHint,
	shouldHideProjectDependentTopBarActions,
	shouldShowProjectLoadingState,
	homeGitSummary,
	selectedTaskWorkspaceSnapshot,
}: ConnectedTopBarProps): ReactElement {
	const project = useProjectContext();
	const { selectedCard } = useBoardContext();
	const git = useGitContext();
	const terminal = useTerminalContext();
	const dialog = useDialogContext();

	return (
		<TopBar
			onBack={onBack}
			workspacePath={navbarWorkspacePath}
			isWorkspacePathLoading={shouldShowProjectLoadingState}
			workspaceHint={navbarWorkspaceHint}
			runtimeHint={navbarRuntimeHint}
			selectedTaskId={selectedCard?.card.id ?? null}
			scopeType={selectedCard ? "task" : (git.fileBrowserResolvedScope?.type ?? "home")}
			taskTitle={selectedCard?.card.title ?? null}
			onToggleTerminal={
				project.hasNoProjects
					? undefined
					: selectedCard
						? terminal.handleToggleDetailTerminal
						: terminal.handleToggleHomeTerminal
			}
			isTerminalOpen={selectedCard ? terminal.isDetailTerminalOpen : terminal.showHomeBottomTerminal}
			isTerminalLoading={selectedCard ? terminal.isDetailTerminalStarting : terminal.isHomeTerminalStarting}
			onOpenSettings={dialog.handleOpenSettings}
			showDebugButton={dialog.debugModeEnabled}
			onOpenDebugDialog={dialog.debugModeEnabled ? dialog.handleOpenDebugDialog : undefined}
			shortcuts={project.shortcuts}
			selectedShortcutLabel={project.selectedShortcutLabel}
			onSelectShortcutLabel={handleSelectShortcutLabel}
			runningShortcutLabel={runningShortcutLabel}
			onRunShortcut={handleRunShortcut}
			onCreateFirstShortcut={project.currentProjectId ? handleCreateShortcut : undefined}
			promptShortcuts={project.runtimeProjectConfig?.promptShortcuts ?? []}
			activePromptShortcut={activePromptShortcut}
			onSelectPromptShortcutLabel={selectPromptShortcutLabel}
			isPromptShortcutRunning={isPromptShortcutRunning}
			onRunPromptShortcut={runPromptShortcut}
			onManagePromptShortcuts={() => dialog.setPromptShortcutEditorOpen(true)}
			hideProjectDependentActions={shouldHideProjectDependentTopBarActions}
			branchPillSlot={
				git.topbarBranchLabel ? (
					<div className="flex items-center gap-1.5">
						<BranchSelectorPopover
							isOpen={git.topbarBranchActions.isBranchPopoverOpen}
							onOpenChange={git.topbarBranchActions.setBranchPopoverOpen}
							branches={git.topbarBranchActions.branches}
							currentBranch={git.topbarBranchActions.currentBranch}
							worktreeBranches={git.topbarBranchActions.worktreeBranches}
							onSelectBranchView={git.topbarBranchActions.handleSelectBranchView}
							onCheckoutBranch={git.topbarBranchActions.handleCheckoutBranch}
							onCompareWithBranch={(branch) => git.openGitCompare({ targetRef: branch })}
							onMergeBranch={git.topbarBranchActions.handleMergeBranch}
							onCreateBranch={git.topbarBranchActions.handleCreateBranchFrom}
							onDeleteBranch={git.topbarBranchActions.handleDeleteBranch}
							onRebaseBranch={git.topbarBranchActions.handleRebaseBranch}
							onRenameBranch={git.topbarBranchActions.handleRenameBranch}
							onResetToRef={git.topbarBranchActions.handleResetToRef}
							onPull={(branch) => {
								void git.runGitAction("pull", git.gitSyncTaskScope ?? null, branch);
							}}
							onPush={(branch) => {
								void git.runGitAction("push", git.gitSyncTaskScope ?? null, branch);
							}}
							pinnedBranches={project.pinnedBranches}
							onTogglePinBranch={project.handleTogglePinBranch}
							trigger={
								<BranchPillTrigger
									label={git.topbarBranchLabel}
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
									icon={
										git.runningGitAction === "fetch" ? <Spinner size={12} /> : <CircleArrowDown size={14} />
									}
									onClick={() => {
										void git.runGitAction("fetch", git.gitSyncTaskScope);
									}}
									disabled={git.runningGitAction != null}
									aria-label="Fetch from upstream"
								/>
							</Tooltip>
							<Tooltip side="bottom" content="Pull from upstream">
								<Button
									variant="ghost"
									size="sm"
									className="h-6"
									icon={git.runningGitAction === "pull" ? <Spinner size={12} /> : <ArrowDown size={12} />}
									onClick={() => {
										void git.runGitAction("pull", git.gitSyncTaskScope);
									}}
									disabled={git.runningGitAction != null}
									aria-label="Pull from upstream"
								/>
							</Tooltip>
							<Tooltip side="bottom" content="Push to upstream">
								<Button
									variant="ghost"
									size="sm"
									className="h-6"
									icon={git.runningGitAction === "push" ? <Spinner size={12} /> : <ArrowUp size={12} />}
									onClick={() => {
										void git.runGitAction("push", git.gitSyncTaskScope);
									}}
									disabled={git.runningGitAction != null}
									aria-label="Push to upstream"
								/>
							</Tooltip>
						</div>
					</div>
				) : undefined
			}
		/>
	);
}
