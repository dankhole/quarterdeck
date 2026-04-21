import * as RadixPopover from "@radix-ui/react-popover";
import { ArrowDown, ArrowUp, Check, CircleArrowDown, Lock, LockOpen, Search } from "lucide-react";
import { type ReactElement, useCallback, useMemo, useRef, useState } from "react";
import { TopBar } from "@/components/app/top-bar";
import { BranchPillTrigger, BranchSelectorPopover } from "@/components/git/panels/branch-selector-popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useBoardContext } from "@/providers/board-provider";
import { useDialogContext } from "@/providers/dialog-provider";
import { useGitContext } from "@/providers/git-provider";
import { useProjectContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { useSurfaceNavigationContext } from "@/providers/surface-navigation-provider";
import { useTerminalContext } from "@/providers/terminal-provider";
import type { PromptShortcut, RuntimeGitRef, RuntimeGitSyncSummary, RuntimeProjectShortcut } from "@/runtime/types";
import type { BoardCard, ReviewTaskWorktreeSnapshot } from "@/types";

function BaseRefLabel({
	card,
	behindBaseCount,
	branches,
	isLoadingBranches,
	requestBranches,
	onUpdateBaseRef,
}: {
	card: BoardCard;
	behindBaseCount: number | null | undefined;
	branches: RuntimeGitRef[] | null;
	isLoadingBranches: boolean;
	requestBranches: () => void;
	onUpdateBaseRef: (taskId: string, baseRef: string, pinned: boolean) => void;
}): ReactElement {
	const [isOpen, setIsOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const [pinned, setPinned] = useState(card.baseRefPinned === true);
	const inputRef = useRef<HTMLInputElement>(null);

	const handleOpen = useCallback(
		(open: boolean) => {
			if (open) {
				setFilter("");
				setPinned(card.baseRefPinned === true);
				requestBranches();
			}
			setIsOpen(open);
		},
		[card.baseRefPinned, requestBranches],
	);

	const handleSelect = useCallback(
		(branchName: string) => {
			if (branchName !== card.baseRef || pinned !== (card.baseRefPinned === true)) {
				onUpdateBaseRef(card.id, branchName, pinned);
			}
			setIsOpen(false);
		},
		[pinned, card.baseRef, card.baseRefPinned, card.id, onUpdateBaseRef],
	);

	const localBranches = useMemo(() => {
		if (!branches) return [];
		return branches.filter((ref) => ref.type === "branch");
	}, [branches]);

	const filteredBranches = useMemo(() => {
		if (!filter) return localBranches;
		const lower = filter.toLowerCase();
		return localBranches.filter((ref) => ref.name.toLowerCase().includes(lower));
	}, [localBranches, filter]);

	return (
		<RadixPopover.Root open={isOpen} onOpenChange={handleOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					className={cn(
						"text-xs whitespace-nowrap cursor-pointer flex items-center gap-1 px-1.5 py-0.5 rounded",
						isOpen
							? "bg-surface-2 text-text-secondary"
							: "text-text-tertiary hover:text-text-secondary hover:bg-surface-2",
					)}
				>
					{card.baseRefPinned ? <Lock size={10} className="text-text-quaternary" /> : null}
					from <span className="font-mono">{card.baseRef}</span>
					{(behindBaseCount ?? 0) > 0 ? (
						<span className="text-status-blue">({behindBaseCount} behind)</span>
					) : null}
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={6}
					className="z-50 rounded-md border border-border bg-bg-secondary shadow-lg w-56"
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						inputRef.current?.focus();
					}}
				>
					<div className="flex flex-col">
						<div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
							<Search size={12} className="text-text-quaternary shrink-0" />
							<input
								ref={inputRef}
								type="text"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Escape") setIsOpen(false);
								}}
								placeholder="Filter branches..."
								className="h-5 w-full bg-transparent text-xs text-text-primary font-mono placeholder:text-text-quaternary focus:outline-none"
							/>
						</div>
						<div className="max-h-48 overflow-y-auto py-1">
							{isLoadingBranches && !branches ? (
								<div className="flex items-center justify-center gap-1.5 px-3 py-3">
									<Spinner size={12} />
									<span className="text-xs text-text-tertiary">Loading branches...</span>
								</div>
							) : filteredBranches.length === 0 ? (
								<div className="px-3 py-2 text-xs text-text-quaternary">No matching branches</div>
							) : (
								filteredBranches.map((ref) => (
									<button
										key={ref.name}
										type="button"
										className="flex items-center gap-2 w-full px-3 py-1 text-xs text-text-secondary hover:bg-bg-tertiary cursor-pointer text-left"
										onClick={() => handleSelect(ref.name)}
									>
										<span className="w-3 shrink-0">
											{ref.name === card.baseRef ? <Check size={12} className="text-accent-blue" /> : null}
										</span>
										<span className="font-mono truncate">{ref.name}</span>
									</button>
								))
							)}
						</div>
						<div className="border-t border-border px-2 py-1.5">
							<button
								type="button"
								className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary cursor-pointer"
								onClick={() => {
									const next = !pinned;
									setPinned(next);
									if (next !== (card.baseRefPinned === true)) {
										onUpdateBaseRef(card.id, card.baseRef, next);
									}
								}}
							>
								{pinned ? <Lock size={11} /> : <LockOpen size={11} />}
								{pinned ? "Pinned — won't auto-update" : "Unpinned — auto-updates on branch change"}
							</button>
						</div>
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}

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
