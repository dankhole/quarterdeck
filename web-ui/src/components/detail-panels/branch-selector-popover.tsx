import * as ContextMenu from "@radix-ui/react-context-menu";
import * as RadixPopover from "@radix-ui/react-popover";
import { Fzf } from "fzf";
import {
	ArrowDown,
	ArrowUp,
	Check,
	ChevronDown,
	ClipboardCopy,
	Eye,
	GitBranch,
	GitBranchPlus,
	GitCompareArrows,
	GitMerge,
	Locate,
	LogIn,
	Pencil,
	Pin,
	PinOff,
	RotateCcw,
	Search,
	Trash2,
} from "lucide-react";
import { forwardRef, useCallback, useMemo, useRef, useState } from "react";
import { CONTEXT_MENU_ITEM_CLASS, copyToClipboard } from "@/components/detail-panels/context-menu-utils";
import { cn } from "@/components/ui/cn";
import { Tooltip, TruncateTooltip } from "@/components/ui/tooltip";
import type { RuntimeGitRef } from "@/runtime/types";

/**
 * Full-featured branch picker used in the file browser scope bar (home + task
 * detail) and the git view's source/target ref selectors. Shows local/remote
 * grouping with fuzzy search, checkout actions, and worktree-locked indicators.
 *
 * When adding this component to a new site, wire up `onCheckoutBranch` and
 * `onCompareWithBranch` unless the context specifically doesn't support those
 * actions (e.g. the Compare bar ref selectors, which are pure ref pickers).
 *
 * For simple branch selection (e.g. task creation), use BranchSelectDropdown instead.
 */
interface BranchSelectorPopoverProps {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	branches: RuntimeGitRef[] | null;
	currentBranch: string | null;
	worktreeBranches: Map<string, string>;
	onSelectBranchView: (ref: string) => void;
	/** When provided, shows "Checkout" in the branch right-click menu and inline icon. */
	onCheckoutBranch?: (branch: string) => void;
	/** When provided, shows "Compare with local tree" in the branch right-click menu. */
	onCompareWithBranch?: (branchName: string) => void;
	/** When provided, shows "Merge into current" in the branch right-click menu. */
	onMergeBranch?: (branchName: string) => void;
	/** When provided, shows "Create branch from here" in the branch right-click menu. */
	onCreateBranch?: (sourceRef: string) => void;
	/** When provided, shows "Delete branch" in the branch right-click menu (local branches only). */
	onDeleteBranch?: (branchName: string) => void;
	/** When provided, shows "Rebase onto" in the branch right-click menu. */
	onRebaseBranch?: (onto: string) => void;
	/** When provided, shows "Rename branch" in the branch right-click menu (local branches only). */
	onRenameBranch?: (branchName: string) => void;
	/** When provided, shows "Reset to here" in the branch right-click menu. */
	onResetToRef?: (ref: string) => void;
	/** When provided, shows "Pull from remote" in any local branch's right-click menu. */
	onPull?: (branch: string) => void;
	/** When provided, shows "Push to remote" in any local branch's right-click menu. */
	onPush?: (branch: string) => void;
	/** Branch names that should appear in a "Pinned" section at the top. */
	pinnedBranches?: string[];
	/** When provided, shows "Pin to top" / "Unpin" in the branch right-click menu. */
	onTogglePinBranch?: (branchName: string) => void;
	/** When true, suppresses right-click context menus on branch items. */
	disableContextMenu?: boolean;
	trigger: React.ReactNode;
}

export function BranchSelectorPopover({
	isOpen,
	onOpenChange,
	branches,
	currentBranch,
	worktreeBranches,
	onSelectBranchView,
	onCheckoutBranch,
	onCompareWithBranch,
	onMergeBranch,
	onCreateBranch,
	onDeleteBranch,
	onRebaseBranch,
	onRenameBranch,
	onResetToRef,
	onPull,
	onPush,
	pinnedBranches,
	onTogglePinBranch,
	disableContextMenu,
	trigger,
}: BranchSelectorPopoverProps): React.ReactElement {
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const pinnedSet = useMemo(() => new Set(pinnedBranches ?? []), [pinnedBranches]);

	const detachedRef = useMemo(() => (branches ?? []).find((ref) => ref.type === "detached"), [branches]);
	const localBranches = useMemo(() => (branches ?? []).filter((ref) => ref.type === "branch"), [branches]);
	const remoteBranches = useMemo(() => (branches ?? []).filter((ref) => ref.type === "remote"), [branches]);

	const fzfLocal = useMemo(() => new Fzf(localBranches, { selector: (ref) => ref.name }), [localBranches]);
	const fzfRemote = useMemo(() => new Fzf(remoteBranches, { selector: (ref) => ref.name }), [remoteBranches]);

	const filteredLocal = useMemo(
		() => (query.trim() ? fzfLocal.find(query).map((r) => r.item) : localBranches),
		[query, fzfLocal, localBranches],
	);
	const filteredRemote = useMemo(
		() => (query.trim() ? fzfRemote.find(query).map((r) => r.item) : remoteBranches),
		[query, fzfRemote, remoteBranches],
	);

	// Split local branches into pinned (shown first) and unpinned
	const pinnedLocal = useMemo(
		() => (pinnedSet.size > 0 ? filteredLocal.filter((ref) => pinnedSet.has(ref.name)) : []),
		[filteredLocal, pinnedSet],
	);
	const unpinnedLocal = useMemo(
		() => (pinnedSet.size > 0 ? filteredLocal.filter((ref) => !pinnedSet.has(ref.name)) : filteredLocal),
		[filteredLocal, pinnedSet],
	);

	const handleSelectBranch = useCallback(
		(branchName: string) => {
			onSelectBranchView(branchName);
			onOpenChange(false);
			setQuery("");
		},
		[onSelectBranchView, onOpenChange],
	);

	const handleCheckout = useCallback(
		(branchName: string) => {
			onCheckoutBranch?.(branchName);
			onOpenChange(false);
			setQuery("");
		},
		[onCheckoutBranch, onOpenChange],
	);

	const handleCompare = useCallback(
		(branchName: string) => {
			onCompareWithBranch?.(branchName);
			onOpenChange(false);
			setQuery("");
		},
		[onCompareWithBranch, onOpenChange],
	);

	const handleMerge = useCallback(
		(branchName: string) => {
			onMergeBranch?.(branchName);
			onOpenChange(false);
			setQuery("");
		},
		[onMergeBranch, onOpenChange],
	);

	const handleCreateBranch = useCallback(
		(sourceRef: string) => {
			onCreateBranch?.(sourceRef);
			onOpenChange(false);
			setQuery("");
		},
		[onCreateBranch, onOpenChange],
	);

	const handleRebase = useCallback(
		(onto: string) => {
			onRebaseBranch?.(onto);
			onOpenChange(false);
			setQuery("");
		},
		[onRebaseBranch, onOpenChange],
	);

	const handleRename = useCallback(
		(branchName: string) => {
			onRenameBranch?.(branchName);
			onOpenChange(false);
			setQuery("");
		},
		[onRenameBranch, onOpenChange],
	);

	const handleReset = useCallback(
		(ref: string) => {
			onResetToRef?.(ref);
			onOpenChange(false);
			setQuery("");
		},
		[onResetToRef, onOpenChange],
	);

	const handlePull = useCallback(
		(branch: string) => {
			onPull?.(branch);
			onOpenChange(false);
			setQuery("");
		},
		[onPull, onOpenChange],
	);

	const handlePush = useCallback(
		(branch: string) => {
			onPush?.(branch);
			onOpenChange(false);
			setQuery("");
		},
		[onPush, onOpenChange],
	);

	const closePopover = useCallback(() => {
		onOpenChange(false);
		setQuery("");
	}, [onOpenChange]);

	const handleOpenChange = useCallback(
		(open: boolean) => {
			onOpenChange(open);
			if (!open) {
				setQuery("");
			}
		},
		[onOpenChange],
	);

	return (
		<RadixPopover.Root open={isOpen} onOpenChange={handleOpenChange}>
			<RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={4}
					collisionPadding={8}
					className="z-50 w-80 rounded-lg border border-border bg-surface-1 shadow-lg"
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						inputRef.current?.focus();
					}}
				>
					<div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
						<Search size={13} className="text-text-tertiary shrink-0" />
						<input
							ref={inputRef}
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Filter branches..."
							className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none"
						/>
					</div>
					<div className="max-h-64 overflow-y-auto overscroll-contain py-1">
						{detachedRef && !query.trim() ? (
							<>
								<div className="px-2 py-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
									Working tree
								</div>
								{disableContextMenu ? (
									<div className="flex items-center gap-1.5 w-full px-2 py-1 text-xs text-text-secondary">
										<Locate size={12} className="shrink-0 text-status-orange" />
										<span className="truncate font-mono text-status-orange">HEAD ({detachedRef.name})</span>
										<Check size={12} className="shrink-0 text-accent ml-auto" />
									</div>
								) : (
									<ContextMenu.Root>
										<ContextMenu.Trigger asChild>
											<div className="flex items-center gap-1.5 w-full px-2 py-1 text-xs text-text-secondary">
												<Locate size={12} className="shrink-0 text-status-orange" />
												<span className="truncate font-mono text-status-orange">
													HEAD ({detachedRef.name})
												</span>
												<Check size={12} className="shrink-0 text-accent ml-auto" />
											</div>
										</ContextMenu.Trigger>
										{onPull || onPush ? (
											<ContextMenu.Portal>
												<ContextMenu.Content className="z-50 min-w-[160px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg">
													{/* Uses onSelect + preventDefault instead of Radix `disabled` prop because
													   Radix disabled blocks pointer events, which prevents the wrapping Tooltip
													   from showing. */}
													{onPull ? (
														<Tooltip
															content="Cannot pull on a detached HEAD — checkout a branch first"
															side="right"
														>
															<ContextMenu.Item
																className={cn(CONTEXT_MENU_ITEM_CLASS, "opacity-50 cursor-not-allowed")}
																onSelect={(e) => e.preventDefault()}
															>
																<ArrowDown size={14} className="text-text-secondary" />
																Pull from remote
															</ContextMenu.Item>
														</Tooltip>
													) : null}
													{onPush ? (
														<Tooltip
															content="Cannot push from a detached HEAD — checkout a branch first"
															side="right"
														>
															<ContextMenu.Item
																className={cn(CONTEXT_MENU_ITEM_CLASS, "opacity-50 cursor-not-allowed")}
																onSelect={(e) => e.preventDefault()}
															>
																<ArrowUp size={14} className="text-text-secondary" />
																Push to remote
															</ContextMenu.Item>
														</Tooltip>
													) : null}
												</ContextMenu.Content>
											</ContextMenu.Portal>
										) : null}
									</ContextMenu.Root>
								)}
							</>
						) : null}
						{pinnedLocal.length > 0 ? (
							<>
								<div className="px-2 py-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
									Pinned
								</div>
								{pinnedLocal.map((gitRef) => (
									<BranchItem
										key={gitRef.name}
										gitRef={gitRef}
										isCurrent={gitRef.name === currentBranch}
										worktreeTaskTitle={worktreeBranches.get(gitRef.name)}
										isPinned
										disableContextMenu={disableContextMenu}
										onSelect={handleSelectBranch}
										onCheckout={onCheckoutBranch ? handleCheckout : undefined}
										onCompare={onCompareWithBranch ? handleCompare : undefined}
										onMerge={onMergeBranch ? handleMerge : undefined}
										onCreateBranch={onCreateBranch ? handleCreateBranch : undefined}
										onDeleteBranch={onDeleteBranch}
										onRebase={onRebaseBranch ? handleRebase : undefined}
										onRename={onRenameBranch ? handleRename : undefined}
										onReset={onResetToRef ? handleReset : undefined}
										onTogglePin={onTogglePinBranch}
										onPull={onPull ? handlePull : undefined}
										onPush={onPush ? handlePush : undefined}
										onClose={closePopover}
									/>
								))}
							</>
						) : null}
						{unpinnedLocal.length > 0 ? (
							<>
								<div className="px-2 py-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
									Local
								</div>
								{unpinnedLocal.map((gitRef) => (
									<BranchItem
										key={gitRef.name}
										gitRef={gitRef}
										isCurrent={gitRef.name === currentBranch}
										worktreeTaskTitle={worktreeBranches.get(gitRef.name)}
										disableContextMenu={disableContextMenu}
										onSelect={handleSelectBranch}
										onCheckout={onCheckoutBranch ? handleCheckout : undefined}
										onCompare={onCompareWithBranch ? handleCompare : undefined}
										onMerge={onMergeBranch ? handleMerge : undefined}
										onCreateBranch={onCreateBranch ? handleCreateBranch : undefined}
										onDeleteBranch={onDeleteBranch}
										onRebase={onRebaseBranch ? handleRebase : undefined}
										onRename={onRenameBranch ? handleRename : undefined}
										onReset={onResetToRef ? handleReset : undefined}
										onTogglePin={onTogglePinBranch}
										onPull={onPull ? handlePull : undefined}
										onPush={onPush ? handlePush : undefined}
										onClose={closePopover}
									/>
								))}
							</>
						) : null}
						{filteredRemote.length > 0 ? (
							<>
								<div className="px-2 py-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mt-1">
									Remote
								</div>
								{filteredRemote.map((gitRef) => (
									<BranchItem
										key={gitRef.name}
										gitRef={gitRef}
										isCurrent={false}
										worktreeTaskTitle={undefined}
										disableContextMenu={disableContextMenu}
										onSelect={handleSelectBranch}
										onCheckout={onCheckoutBranch ? handleCheckout : undefined}
										onCompare={onCompareWithBranch ? handleCompare : undefined}
										onMerge={onMergeBranch ? handleMerge : undefined}
										onCreateBranch={onCreateBranch ? handleCreateBranch : undefined}
										onRebase={onRebaseBranch ? handleRebase : undefined}
										onReset={onResetToRef ? handleReset : undefined}
										onClose={closePopover}
									/>
								))}
							</>
						) : null}
						{pinnedLocal.length === 0 && unpinnedLocal.length === 0 && filteredRemote.length === 0 ? (
							<div className="px-2 py-3 text-xs text-text-tertiary text-center">
								{branches === null ? "Loading branches..." : "No matching branches"}
							</div>
						) : null}
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}

export const BranchPillTrigger = forwardRef<
	HTMLButtonElement,
	{ label: string; aheadCount?: number; behindCount?: number } & React.ComponentPropsWithoutRef<"button">
>(function BranchPillTrigger({ label, aheadCount, behindCount, className, ...rest }, ref) {
	const ahead = aheadCount ?? 0;
	const behind = behindCount ?? 0;
	return (
		<button
			ref={ref}
			{...rest}
			type="button"
			className={cn(
				"inline-flex items-center gap-1 px-1.5 h-5 rounded border border-border-bright bg-surface-2 hover:bg-surface-3 text-xs font-mono cursor-pointer shrink min-w-0",
				className,
			)}
			aria-label="Switch branch"
		>
			<GitBranch size={11} className="shrink-0 text-text-tertiary" />
			<TruncateTooltip content={label} side="bottom">
				<span className="truncate">{label}</span>
			</TruncateTooltip>
			{behind > 0 ? (
				<span className="inline-flex items-center gap-px shrink-0 text-[10px] text-status-blue">
					<ArrowDown size={10} />
					{behind}
				</span>
			) : null}
			{ahead > 0 ? (
				<span className="inline-flex items-center gap-px shrink-0 text-[10px] text-status-green">
					<ArrowUp size={10} />
					{ahead}
				</span>
			) : null}
			<ChevronDown size={10} className="shrink-0 text-text-tertiary" />
		</button>
	);
});

function BranchItem({
	gitRef,
	isCurrent,
	worktreeTaskTitle,
	isPinned,
	disableContextMenu,
	onSelect,
	onCheckout,
	onCompare,
	onMerge,
	onCreateBranch,
	onDeleteBranch,
	onRebase,
	onRename,
	onReset,
	onTogglePin,
	onPull,
	onPush,
	onClose,
}: {
	gitRef: RuntimeGitRef;
	isCurrent: boolean;
	worktreeTaskTitle: string | undefined;
	isPinned?: boolean;
	disableContextMenu?: boolean;
	onSelect: (name: string) => void;
	onCheckout?: (name: string) => void;
	onCompare?: (name: string) => void;
	onMerge?: (name: string) => void;
	onCreateBranch?: (sourceRef: string) => void;
	onDeleteBranch?: (branchName: string) => void;
	onRebase?: (onto: string) => void;
	onRename?: (branchName: string) => void;
	onReset?: (ref: string) => void;
	onTogglePin?: (branchName: string) => void;
	onPull?: (branch: string) => void;
	onPush?: (branch: string) => void;
	onClose: () => void;
}): React.ReactElement {
	const isLocked = worktreeTaskTitle !== undefined;
	const shortName = gitRef.name.replace(/^origin\//, "");
	const rowRef = useRef<HTMLButtonElement>(null);

	const rowButton = (
		<button
			ref={rowRef}
			type="button"
			onClick={(e) => {
				if (disableContextMenu) {
					onSelect(gitRef.name);
					return;
				}
				// Open context menu on left-click by dispatching a synthetic contextmenu event
				// at the click position so Radix ContextMenu picks it up.
				e.preventDefault();
				e.stopPropagation();
				const syntheticEvent = new MouseEvent("contextmenu", {
					bubbles: true,
					cancelable: true,
					clientX: e.clientX,
					clientY: e.clientY,
				});
				rowRef.current?.dispatchEvent(syntheticEvent);
			}}
			className="flex items-center gap-1.5 w-full px-2 py-1 text-xs text-left text-text-secondary hover:bg-surface-2 cursor-pointer"
		>
			<GitBranch size={12} className="shrink-0" />
			<TruncateTooltip content={gitRef.name} side="top">
				<span className="flex-1 truncate">{shortName}</span>
			</TruncateTooltip>
			{gitRef.behind && gitRef.behind > 0 ? (
				<span className="inline-flex items-center gap-px shrink-0 text-[10px] text-status-blue">
					<ArrowDown size={10} />
					{gitRef.behind}
				</span>
			) : null}
			{gitRef.ahead && gitRef.ahead > 0 ? (
				<span className="inline-flex items-center gap-px shrink-0 text-[10px] text-status-green">
					<ArrowUp size={10} />
					{gitRef.ahead}
				</span>
			) : null}
			{isCurrent ? <Check size={12} className="shrink-0 text-accent" /> : null}
			{isLocked ? (
				<Tooltip content={`Checked out by Task: ${worktreeTaskTitle}`} side="right">
					<span className="text-[10px] text-text-tertiary">in use</span>
				</Tooltip>
			) : onCheckout ? (
				<Tooltip content="Checkout this branch" side="right">
					<span
						role="button"
						tabIndex={0}
						onClick={(e) => {
							e.stopPropagation();
							onCheckout(gitRef.name);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.stopPropagation();
								onCheckout(gitRef.name);
							}
						}}
						className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface-3"
					>
						<LogIn size={12} />
					</span>
				</Tooltip>
			) : null}
		</button>
	);

	if (disableContextMenu) return rowButton;

	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger asChild>{rowButton}</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Content className="z-50 min-w-[160px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg">
					<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={() => onSelect(gitRef.name)}>
						<Eye size={14} className="text-text-secondary" />
						Browse files
					</ContextMenu.Item>
					{onCheckout ? (
						<ContextMenu.Item
							className={cn(CONTEXT_MENU_ITEM_CLASS, isLocked && "opacity-50 cursor-not-allowed")}
							disabled={isLocked}
							onSelect={() => onCheckout(gitRef.name)}
						>
							<LogIn size={14} className="text-text-secondary" />
							Checkout
						</ContextMenu.Item>
					) : null}
					{onCompare ? (
						<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={() => onCompare(gitRef.name)}>
							<GitCompareArrows size={14} className="text-text-secondary" />
							Compare with local tree
						</ContextMenu.Item>
					) : null}
					{onMerge ? (
						<ContextMenu.Item
							className={cn(CONTEXT_MENU_ITEM_CLASS, isCurrent && "opacity-50 cursor-not-allowed")}
							disabled={isCurrent}
							onSelect={() => onMerge(gitRef.name)}
						>
							<GitMerge size={14} className="text-text-secondary" />
							Merge into current
						</ContextMenu.Item>
					) : null}
					{onCreateBranch ? (
						<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={() => onCreateBranch(gitRef.name)}>
							<GitBranchPlus size={14} className="text-text-secondary" />
							Create branch from here
						</ContextMenu.Item>
					) : null}
					{onPull ? (
						<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={() => onPull(gitRef.name)}>
							<ArrowDown size={14} className="text-text-secondary" />
							Pull from remote
						</ContextMenu.Item>
					) : null}
					{onPush ? (
						<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={() => onPush(gitRef.name)}>
							<ArrowUp size={14} className="text-text-secondary" />
							Push to remote
						</ContextMenu.Item>
					) : null}
					{onRebase ? (
						<ContextMenu.Item
							className={cn(CONTEXT_MENU_ITEM_CLASS, isCurrent && "opacity-50 cursor-not-allowed")}
							disabled={isCurrent}
							onSelect={() => onRebase(gitRef.name)}
						>
							<RotateCcw size={14} className="text-text-secondary" />
							Rebase onto
						</ContextMenu.Item>
					) : null}
					{onReset ? (
						<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={() => onReset(gitRef.name)}>
							<RotateCcw size={14} className="text-status-red" />
							Reset to here
						</ContextMenu.Item>
					) : null}
					{onCheckout || onCompare || onMerge || onCreateBranch || onPull || onPush || onRebase || onReset ? (
						<ContextMenu.Separator className="my-1 h-px bg-border" />
					) : null}
					<ContextMenu.Item
						className={CONTEXT_MENU_ITEM_CLASS}
						onSelect={() => {
							copyToClipboard(gitRef.name, "Branch name");
							onClose();
						}}
					>
						<ClipboardCopy size={14} className="text-text-secondary" />
						Copy branch name
					</ContextMenu.Item>
					{onTogglePin && gitRef.type === "branch" ? (
						<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={() => onTogglePin(gitRef.name)}>
							{isPinned ? (
								<>
									<PinOff size={14} className="text-text-secondary" />
									Unpin
								</>
							) : (
								<>
									<Pin size={14} className="text-text-secondary" />
									Pin to top
								</>
							)}
						</ContextMenu.Item>
					) : null}
					{onRename && gitRef.type === "branch" ? (
						<ContextMenu.Item
							className={cn(CONTEXT_MENU_ITEM_CLASS, isLocked && "opacity-50 cursor-not-allowed")}
							disabled={isLocked}
							onSelect={() => onRename(gitRef.name)}
						>
							<Pencil size={14} className="text-text-secondary" />
							Rename branch
						</ContextMenu.Item>
					) : null}
					{onDeleteBranch && gitRef.type === "branch" ? (
						<>
							<ContextMenu.Separator className="my-1 h-px bg-border" />
							<ContextMenu.Item
								className={cn(
									CONTEXT_MENU_ITEM_CLASS,
									"text-status-red",
									(isCurrent || isLocked) && "opacity-50 cursor-not-allowed",
								)}
								disabled={isCurrent || isLocked}
								onSelect={() => onDeleteBranch(gitRef.name)}
							>
								<Trash2 size={14} />
								Delete branch
							</ContextMenu.Item>
						</>
					) : null}
				</ContextMenu.Content>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
