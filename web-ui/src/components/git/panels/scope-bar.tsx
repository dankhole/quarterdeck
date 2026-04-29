import { AlertTriangle, CornerDownLeft, House, Info, LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { ResolvedScope, ScopeMode } from "@/hooks/git/use-scope-context";
import type { RuntimeGitSyncSummary } from "@/runtime/types";
import { formatDetachedWorktreeLabel, getDetachedWorktreeTooltip } from "@/utils/detached-worktree-copy";

/**
 * Breadcrumb bar at the top of the **Files tab** (both home and task detail views).
 * Shows the current scope (task branch, browsing another branch, etc.) with an
 * optional clickable branch pill for checkout/compare actions.
 */
interface ScopeBarProps {
	resolvedScope: ResolvedScope | null;
	scopeMode: ScopeMode;
	homeGitSummary: RuntimeGitSyncSummary | null;
	taskTitle: string | null;
	taskBranch: string | null;
	taskBaseRef: string | null;
	behindBaseCount: number | null;
	isDetachedHead: boolean;
	/** Whether the task worktree is on a detached HEAD (headless). */
	taskIsDetached?: boolean;
	onSwitchToHome: () => void;
	onReturnToContextual: () => void;
	/**
	 * Replaces the static branch name with a clickable pill (typically a
	 * BranchSelectorPopover trigger). Rendered inline in the scope content.
	 */
	branchPillSlot?: ReactNode;
	/** Called when the user clicks "Checkout" in branch_view mode. */
	onCheckoutBrowsingBranch?: () => void;
}

function ScopeBarButton({
	onClick,
	label,
	children,
}: {
	onClick: () => void;
	label: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Tooltip content={label}>
			<button
				type="button"
				onClick={onClick}
				className="flex items-center justify-center w-5 h-5 rounded-sm cursor-pointer border-0 bg-transparent text-text-tertiary hover:text-text-secondary"
				aria-label={label}
			>
				{children}
			</button>
		</Tooltip>
	);
}

function HomeContent({
	homeGitSummary,
	isDetachedHead,
	branchPillSlot,
}: {
	homeGitSummary: RuntimeGitSyncSummary | null;
	isDetachedHead: boolean;
	branchPillSlot?: ReactNode;
}): React.ReactElement {
	if (isDetachedHead) {
		const shortCommit = homeGitSummary?.currentBranch ?? "unknown";
		return (
			<>
				<span className="text-text-secondary font-medium">Home</span>
				<span className="text-text-tertiary">&middot;</span>
				<AlertTriangle size={12} className="text-status-orange shrink-0" />
				<span className="text-status-orange truncate">HEAD (detached at {shortCommit})</span>
			</>
		);
	}

	const branch = homeGitSummary?.currentBranch ?? "unknown";
	const changedFiles = homeGitSummary?.changedFiles ?? 0;
	const statusText =
		changedFiles === 0 ? "clean" : `${changedFiles} uncommitted change${changedFiles !== 1 ? "s" : ""}`;

	return (
		<>
			<span className="text-text-secondary font-medium">Home</span>
			<span className="text-text-tertiary">&middot;</span>
			{branchPillSlot ?? <span className="text-text-tertiary truncate">{branch}</span>}
			<span className="text-text-tertiary">&middot;</span>
			<span className={cn("truncate", changedFiles === 0 ? "text-text-tertiary" : "text-status-orange")}>
				{statusText}
			</span>
		</>
	);
}

function TaskContent({
	taskTitle,
	taskBranch,
	taskBaseRef,
	behindBaseCount,
	taskIsDetached,
	branchPillSlot,
}: {
	taskTitle: string | null;
	taskBranch: string | null;
	taskBaseRef: string | null;
	behindBaseCount: number | null;
	taskIsDetached?: boolean;
	branchPillSlot?: ReactNode;
}): React.ReactElement {
	const title = taskTitle ?? "Untitled";

	// Only show "(initializing)" when there's no branch AND no pill slot
	// (headless worktrees have no branch but the parent provides a pill with the commit hash)
	if (!taskBranch && !branchPillSlot) {
		return (
			<>
				<span className="text-accent font-medium">Task</span>
				<span className="text-text-tertiary">&middot;</span>
				<span className="text-text-primary truncate">{title}</span>
				<span className="text-text-tertiary">&middot;</span>
				<span className="text-text-tertiary italic">(initializing)</span>
			</>
		);
	}

	// Detached worktrees need base context because several tasks may share one HEAD hash.
	const detachedLabel = taskIsDetached ? formatDetachedWorktreeLabel(taskBaseRef) : null;
	const behindText = behindBaseCount !== null && behindBaseCount > 0 ? ` (${behindBaseCount} behind)` : "";

	return (
		<>
			<span className="text-accent font-medium">Task</span>
			<span className="text-text-tertiary">&middot;</span>
			<span className="text-text-primary truncate">{title}</span>
			<span className="text-text-tertiary">&middot;</span>
			{branchPillSlot ?? <span className="text-text-tertiary truncate">on {taskBranch}</span>}
			{detachedLabel ? (
				<>
					<span className="text-text-tertiary">&middot;</span>
					<Tooltip content={getDetachedWorktreeTooltip({ baseRef: taskBaseRef })}>
						<span
							className={cn(
								"inline-flex min-w-0 items-center gap-1 truncate",
								behindBaseCount && behindBaseCount > 0 ? "text-status-blue" : "text-text-tertiary",
							)}
						>
							<Info size={11} className="shrink-0" />
							<span className="truncate">
								{detachedLabel}
								{behindText}
							</span>
						</span>
					</Tooltip>
				</>
			) : null}
		</>
	);
}

function BranchViewContent({
	resolvedScope,
	branchPillSlot,
}: {
	resolvedScope: ResolvedScope;
	branchPillSlot?: ReactNode;
}): React.ReactElement {
	const ref = resolvedScope.type === "branch_view" ? resolvedScope.ref : "unknown";

	return (
		<>
			<span className="text-status-purple font-medium">Browsing</span>
			<span className="text-text-tertiary">&middot;</span>
			{branchPillSlot ?? <span className="text-text-primary truncate">{ref}</span>}
			<span className="text-text-tertiary">&middot;</span>
			<span className="text-text-tertiary italic">read-only</span>
		</>
	);
}

export function ScopeBar({
	resolvedScope,
	scopeMode,
	homeGitSummary,
	taskTitle,
	taskBranch,
	taskBaseRef,
	behindBaseCount,
	isDetachedHead,
	taskIsDetached,
	onSwitchToHome,
	onReturnToContextual,
	branchPillSlot,
	onCheckoutBrowsingBranch,
}: ScopeBarProps): React.ReactElement {
	const scopeType = resolvedScope?.type ?? "home";

	const borderColorClass = cn(
		scopeType === "home" && "border-l-text-secondary",
		scopeType === "task" && "border-l-accent",
		scopeType === "branch_view" && "border-l-status-purple",
	);

	return (
		<div
			className={cn(
				"flex items-center gap-1.5 px-2 h-7 min-h-7 bg-surface-1 border-b border-border border-l-3 text-xs select-none",
				borderColorClass,
			)}
		>
			{/* Scope content */}
			<div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
				{scopeType === "home" ? (
					<HomeContent
						homeGitSummary={homeGitSummary}
						isDetachedHead={isDetachedHead}
						branchPillSlot={branchPillSlot}
					/>
				) : scopeType === "task" ? (
					<TaskContent
						taskTitle={taskTitle}
						taskBranch={taskBranch}
						taskBaseRef={taskBaseRef}
						behindBaseCount={behindBaseCount}
						taskIsDetached={taskIsDetached}
						branchPillSlot={branchPillSlot}
					/>
				) : resolvedScope ? (
					<BranchViewContent resolvedScope={resolvedScope} branchPillSlot={branchPillSlot} />
				) : null}
			</div>

			{/* Action buttons */}
			<div className="flex items-center gap-0.5 shrink-0">
				{/* Checkout — branch_view only */}
				{scopeType === "branch_view" && onCheckoutBrowsingBranch ? (
					<Tooltip content="Checkout this branch">
						<button
							type="button"
							onClick={onCheckoutBrowsingBranch}
							className="inline-flex items-center gap-1 px-1.5 h-5 rounded-sm cursor-pointer border-0 bg-transparent text-text-tertiary hover:text-text-secondary text-[11px]"
							aria-label="Checkout this branch"
						>
							<LogIn size={12} />
							<span>Checkout</span>
						</button>
					</Tooltip>
				) : null}

				{/* Return button — any non-contextual mode (home_override or branch_view) */}
				{scopeMode !== "contextual" ? (
					<ScopeBarButton onClick={onReturnToContextual} label="Return to contextual view">
						<CornerDownLeft size={14} />
					</ScopeBarButton>
				) : null}

				{/* Home escape hatch — task context only */}
				{scopeType === "task" ? (
					<ScopeBarButton onClick={onSwitchToHome} label="Go to home view">
						<House size={14} />
					</ScopeBarButton>
				) : null}
			</div>
		</div>
	);
}
