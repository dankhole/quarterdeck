import { isRuntimeTaskBaseRefResolved } from "@runtime-contract";
import { ArrowDown, ArrowUp, CircleArrowDown } from "lucide-react";
import { type ReactElement, useCallback } from "react";
import { BaseRefLabel } from "@/components/app/base-ref-label";
import { TopBar } from "@/components/app/top-bar";
import { showAppToast } from "@/components/app-toaster";
import { BranchPillTrigger, BranchSelectorPopover } from "@/components/git/panels/branch-selector-popover";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { applyTaskBaseRefSelectionToBoard } from "@/hooks/board/task-base-ref-sync";
import {
	isTopbarGitSyncDisabled,
	resolveTopbarGitSyncTaskScope,
	shouldShowHomeBranchTracking,
} from "@/hooks/git/git-actions";
import { useOpenProject } from "@/hooks/project";
import { useBoardContext } from "@/providers/board-provider";
import { useDialogContext } from "@/providers/dialog-provider";
import { useGitContext } from "@/providers/git-provider";
import { useProjectNavigationContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { useSurfaceNavigationContext } from "@/providers/surface-navigation-provider";
import { useTerminalContext } from "@/providers/terminal-provider";
import type {
	PromptShortcut,
	RuntimeGitSyncAction,
	RuntimeGitSyncSummary,
	RuntimeProjectShortcut,
} from "@/runtime/types";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
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
	openProjectPath: string | undefined;
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
	openProjectPath,
	navbarProjectHint,
	navbarRuntimeHint,
	shouldHideProjectDependentTopBarActions,
	shouldShowProjectLoadingState,
	homeGitSummary,
	selectedTaskWorktreeSnapshot,
}: ConnectedTopBarProps): ReactElement {
	const projectNavigation = useProjectNavigationContext();
	const projectRuntime = useProjectRuntimeContext();
	const { selectedCard, setBoard } = useBoardContext();
	const git = useGitContext();
	const navigation = useSurfaceNavigationContext();
	const terminal = useTerminalContext();
	const dialog = useDialogContext();
	const selectedTaskHasBaseRef = selectedCard ? isRuntimeTaskBaseRefResolved(selectedCard.card) : false;
	const selectedTaskUsesSharedCheckout = selectedCard?.card.useWorktree === false;
	const showHomeBranchTracking = shouldShowHomeBranchTracking({
		selectedTaskId: selectedCard?.card.id ?? null,
		selectedTaskUsesSharedCheckout,
	});
	const isGitSyncDisabled = isTopbarGitSyncDisabled({
		runningGitAction: git.runningGitAction,
		selectedTaskId: selectedCard?.card.id ?? null,
		selectedTaskHasBaseRef,
		selectedTaskUsesSharedCheckout,
	});
	const topbarGitSyncTaskScope = resolveTopbarGitSyncTaskScope({
		selectedTaskId: selectedCard?.card.id ?? null,
		selectedTaskBaseRef: selectedCard?.card.baseRef ?? null,
		selectedTaskHasBaseRef,
	});
	const openProject = useOpenProject({
		currentProjectId: projectNavigation.currentProjectId,
		projectPath: openProjectPath,
		runtimePlatform: projectRuntime.runtimeProjectConfig?.runtimePlatform,
	});

	const handleUpdateBaseRef = useCallback(
		(taskId: string, baseRef: string, pinned: boolean) => {
			setBoard((current) => {
				return applyTaskBaseRefSelectionToBoard(current, { taskId, baseRef, pinned });
			});
		},
		[setBoard],
	);

	const handleResyncAgentTerminal = useCallback(() => {
		const taskId = selectedCard?.card.id;
		if (!taskId) {
			return;
		}
		const controller = getTerminalController(taskId);
		if (!controller?.requestRestore) {
			showAppToast({ intent: "danger", message: "Agent terminal is not connected." });
			return;
		}
		const didRequestRestore = controller.requestRestore();
		if (!didRequestRestore) {
			showAppToast({ intent: "danger", message: "Agent terminal is not connected." });
			return;
		}
		showAppToast({ intent: "success", message: "Re-syncing agent terminal", timeout: 3000 });
	}, [selectedCard]);

	const runTopbarGitSyncAction = useCallback(
		(action: RuntimeGitSyncAction, branch?: string | null) => {
			if (isGitSyncDisabled) {
				return;
			}
			void git.runGitAction(action, topbarGitSyncTaskScope, branch, {
				updateHomeSummary: selectedTaskUsesSharedCheckout,
			});
		},
		[git.runGitAction, isGitSyncDisabled, selectedTaskUsesSharedCheckout, topbarGitSyncTaskScope],
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
				projectNavigation.hasNoProjects
					? undefined
					: selectedCard
						? terminal.handleToggleDetailTerminal
						: terminal.handleToggleHomeTerminal
			}
			isTerminalOpen={selectedCard ? terminal.isDetailTerminalOpen : terminal.showHomeBottomTerminal}
			isTerminalLoading={selectedCard ? terminal.isDetailTerminalStarting : terminal.isHomeTerminalStarting}
			onResyncAgentTerminal={
				selectedCard && navigation.mainView === "terminal" && !shouldHideProjectDependentTopBarActions
					? handleResyncAgentTerminal
					: undefined
			}
			onOpenSettings={dialog.handleOpenSettings}
			showDebugButton={dialog.debugModeEnabled}
			onOpenDebugDialog={dialog.debugModeEnabled ? dialog.handleOpenDebugDialog : undefined}
			shortcuts={projectRuntime.shortcuts}
			selectedShortcutLabel={projectRuntime.selectedShortcutLabel}
			onSelectShortcutLabel={handleSelectShortcutLabel}
			runningShortcutLabel={runningShortcutLabel}
			onRunShortcut={handleRunShortcut}
			onCreateFirstShortcut={projectNavigation.currentProjectId ? handleCreateShortcut : undefined}
			promptShortcuts={projectRuntime.runtimeProjectConfig?.promptShortcuts ?? []}
			activePromptShortcut={activePromptShortcut}
			onSelectPromptShortcutLabel={selectPromptShortcutLabel}
			isPromptShortcutRunning={isPromptShortcutRunning}
			onRunPromptShortcut={runPromptShortcut}
			onManagePromptShortcuts={() => dialog.setPromptShortcutEditorOpen(true)}
			openTargetOptions={openProject.openTargetOptions}
			selectedOpenTargetId={openProject.selectedOpenTargetId}
			onSelectOpenTarget={openProject.onSelectOpenTarget}
			onOpenProject={openProject.onOpenProject}
			canOpenProject={
				openProject.canOpenProject && !navbarProjectHint && Boolean(projectRuntime.runtimeProjectConfig)
			}
			isOpeningProject={openProject.isOpeningProject}
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
								runTopbarGitSyncAction("pull", branch);
							}}
							onPush={(branch) => {
								runTopbarGitSyncAction("push", branch);
							}}
							pinnedBranches={projectRuntime.pinnedBranches}
							onTogglePinBranch={projectRuntime.handleTogglePinBranch}
							detachedWorktreeBaseRef={git.topbarDetachedWorktree?.baseRef}
							detachedWorktreeHeadCommit={git.topbarDetachedWorktree?.headCommit}
							trigger={
								<BranchPillTrigger
									label={git.topbarBranchLabel}
									aheadCount={showHomeBranchTracking ? homeGitSummary?.aheadCount : undefined}
									behindCount={showHomeBranchTracking ? homeGitSummary?.behindCount : undefined}
									detachedWorktreeBaseRef={git.topbarDetachedWorktree?.baseRef}
									detachedWorktreeHeadCommit={git.topbarDetachedWorktree?.headCommit}
								/>
							}
						/>
						{selectedCard ? (
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
										runTopbarGitSyncAction("fetch");
									}}
									disabled={isGitSyncDisabled}
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
										runTopbarGitSyncAction("pull");
									}}
									disabled={isGitSyncDisabled}
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
										runTopbarGitSyncAction("push");
									}}
									disabled={isGitSyncDisabled}
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
