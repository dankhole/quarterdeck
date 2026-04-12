import * as ContextMenu from "@radix-ui/react-context-menu";
import * as RadixPopover from "@radix-ui/react-popover";
import { Fzf } from "fzf";
import { Check, ChevronDown, ClipboardCopy, GitBranch, GitCompareArrows, GitMerge, LogIn, Search } from "lucide-react";
import { forwardRef, useCallback, useMemo, useRef, useState } from "react";
import { CONTEXT_MENU_ITEM_CLASS, copyToClipboard } from "@/components/detail-panels/context-menu-utils";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
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
	trigger,
}: BranchSelectorPopoverProps): React.ReactElement {
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

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
					className="z-50 w-64 rounded-lg border border-border bg-surface-1 shadow-lg"
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
						{filteredLocal.length > 0 ? (
							<>
								<div className="px-2 py-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
									Local
								</div>
								{filteredLocal.map((gitRef) => (
									<BranchItem
										key={gitRef.name}
										gitRef={gitRef}
										isCurrent={gitRef.name === currentBranch}
										worktreeTaskTitle={worktreeBranches.get(gitRef.name)}
										onSelect={handleSelectBranch}
										onCheckout={onCheckoutBranch ? handleCheckout : undefined}
										onCompare={onCompareWithBranch ? handleCompare : undefined}
										onMerge={onMergeBranch ? handleMerge : undefined}
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
										onSelect={handleSelectBranch}
										onCheckout={onCheckoutBranch ? handleCheckout : undefined}
										onCompare={onCompareWithBranch ? handleCompare : undefined}
										onMerge={onMergeBranch ? handleMerge : undefined}
										onClose={closePopover}
									/>
								))}
							</>
						) : null}
						{filteredLocal.length === 0 && filteredRemote.length === 0 ? (
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
	{ label: string } & React.ComponentPropsWithoutRef<"button">
>(function BranchPillTrigger({ label, className, ...rest }, ref) {
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
			<span className="truncate">{label}</span>
			<ChevronDown size={10} className="shrink-0 text-text-tertiary" />
		</button>
	);
});

function BranchItem({
	gitRef,
	isCurrent,
	worktreeTaskTitle,
	onSelect,
	onCheckout,
	onCompare,
	onMerge,
	onClose,
}: {
	gitRef: RuntimeGitRef;
	isCurrent: boolean;
	worktreeTaskTitle: string | undefined;
	onSelect: (name: string) => void;
	onCheckout?: (name: string) => void;
	onCompare?: (name: string) => void;
	onMerge?: (name: string) => void;
	onClose: () => void;
}): React.ReactElement {
	const isLocked = worktreeTaskTitle !== undefined;
	const shortName = gitRef.name.replace(/^origin\//, "");

	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger asChild>
				<button
					type="button"
					onClick={() => onSelect(gitRef.name)}
					disabled={isLocked}
					className={cn(
						"flex items-center gap-1.5 w-full px-2 py-1 text-xs text-left",
						isLocked
							? "text-text-tertiary opacity-50 cursor-not-allowed"
							: "text-text-secondary hover:bg-surface-2 cursor-pointer",
					)}
				>
					<GitBranch size={12} className="shrink-0" />
					<span className="flex-1 truncate">{shortName}</span>
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
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Content className="z-50 min-w-[160px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg">
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
					{onCheckout || onCompare || onMerge ? <ContextMenu.Separator className="my-1 h-px bg-border" /> : null}
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
				</ContextMenu.Content>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
