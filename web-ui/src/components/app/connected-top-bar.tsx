import { ArrowDown, ArrowUp, CircleArrowDown } from "lucide-react";
import { type ReactElement, useCallback } from "react";
import { BaseRefLabel } from "@/components/app/base-ref-label";
import { TopBar } from "@/components/app/top-bar";
import { BranchPillTrigger, BranchSelectorPopover } from "@/components/git/panels/branch-selector-popover";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useBoardContext } from "@/providers/board-provider";
import { useDialogContext } from "@/providers/dialog-provider";
import { useGitContext } from "@/providers/git-provider";
import { useProjectContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { useSurfaceNavigationContext } from "@/providers/surface-navigation-provider";
import { useTerminalContext } from "@/providers/terminal-provider";
import type { PromptShortcut, RuntimeGitSyncSummary, RuntimeProjectShortcut } from "@/runtime/types";
import type { ReviewTaskWorktreeSnapshot } from "@/types";

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
	navbarProjectPath: string | undefined;
	navbarProjectHint: string | undefined;
	navbarRuntimeHint: string | undefined;
	shouldHideProjectDependentTopBarActions: boolean;
	shouldShowProjectLoadingState: boolean;
	homeGitSummary: RuntimeGitSyncSummary | null;
	selectedTaskWorktreeSnapshot: ReviewTaskWorktreeSnapshot | null;
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
	navbarProjectPath,
	navbarProjectHint,
	navbarRuntimeHint,
	shouldHideProjectDependentTopBarActions,
	shouldShowProjectLoadingState,
	homeGitSummary,
	selectedTaskWorktreeSnapshot,
}: ConnectedTopBarProps): ReactElement {
	const project = useProjectContext();
	const projectRuntime = useProjectRuntimeContext();
	const { selectedCard, setBoard } = useBoardContext();
	const git = useGitContext();
	const navigation = useSurfaceNavigationContext();
	const terminal = useTerminalContext();
	const dialog = useDialogContext();

	const handleUpdateBaseRef = useCallback(
		(taskId: string, baseRef: string, pinned: boolean) => {
			setBoard((current) => {
				const columns = current.columns.map((col) => ({
					...col,
					cards: col.cards.map((card) =>
						card.id === taskId ? { ...card, baseRef, baseRefPinned: pinned || undefined } : card,
					),
				}));
				return { ...current, columns };
			});
		},
		[setBoard],
	);

	return (
		<TopBar
			onBack={onBack}
			projectPath={navbarProjectPath}
			isProjectPathLoading={shouldShowProjectLoadingState}
			projectHint={navbarProjectHint}
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
			shortcuts={projectRuntime.shortcuts}
			selectedShortcutLabel={projectRuntime.selectedShortcutLabel}
			onSelectShortcutLabel={handleSelectShortcutLabel}
			runningShortcutLabel={runningShortcutLabel}
			onRunShortcut={handleRunShortcut}
			onCreateFirstShortcut={project.currentProjectId ? handleCreateShortcut : undefined}
			promptShortcuts={projectRuntime.runtimeProjectConfig?.promptShortcuts ?? []}
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
							onCompareWithBranch={(branch) => navigation.openGitCompare({ targetRef: branch })}
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
							pinnedBranches={projectRuntime.pinnedBranches}
							onTogglePinBranch={projectRuntime.handleTogglePinBranch}
							trigger={
								<BranchPillTrigger
									label={git.topbarBranchLabel}
									aheadCount={!selectedCard ? homeGitSummary?.aheadCount : undefined}
									behindCount={!selectedCard ? homeGitSummary?.behindCount : undefined}
								/>
							}
						/>
						{selectedCard?.card.baseRef ? (
							<BaseRefLabel
								card={selectedCard.card}
								behindBaseCount={selectedTaskWorktreeSnapshot?.behindBaseCount}
								branches={git.topbarBranchActions.branches}
								isLoadingBranches={git.topbarBranchActions.isLoadingBranches}
								requestBranches={git.topbarBranchActions.requestBranches}
								onUpdateBaseRef={handleUpdateBaseRef}
								pinnedBranches={projectRuntime.pinnedBranches}
							/>
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
