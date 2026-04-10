import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type CheckoutDialogState,
	resolveCheckoutDialogState,
} from "@/components/detail-panels/checkout-confirmation-dialog";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitRef, RuntimeGitRefsResponse, RuntimeGitSyncSummary } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { BoardData } from "@/types";

interface UseBranchActionsOptions {
	workspaceId: string | null;
	board: BoardData;
	selectBranchView: (ref: string) => void;
	homeGitSummary: RuntimeGitSyncSummary | null;
	/** For task scope — the task's current branch. */
	taskBranch?: string | null;
	/** For task scope — whether the working tree has uncommitted changes. */
	taskChangedFiles?: number;
	/** Config: skip task checkout confirmation. */
	skipTaskCheckoutConfirmation?: boolean;
	/** Config: skip home checkout confirmation. */
	skipHomeCheckoutConfirmation?: boolean;
	/** Task ID (when in task context). */
	taskId?: string | null;
	/** Task base ref (when in task context). */
	baseRef?: string | null;
	/** Called after a successful checkout (e.g. to return to contextual view). */
	onCheckoutSuccess?: () => void;
}

export interface UseBranchActionsResult {
	isBranchPopoverOpen: boolean;
	setBranchPopoverOpen: (open: boolean) => void;
	branches: RuntimeGitRef[] | null;
	currentBranch: string | null;
	worktreeBranches: Map<string, string>;
	checkoutDialogState: CheckoutDialogState;
	closeCheckoutDialog: () => void;
	handleSelectBranchView: (ref: string) => void;
	handleCheckoutBranch: (branch: string) => void;
	handleConfirmCheckout: (branch: string, scope: "home" | "task", taskId?: string, baseRef?: string) => void;
}

export function useBranchActions(options: UseBranchActionsOptions): UseBranchActionsResult {
	const {
		workspaceId,
		board,
		selectBranchView,
		homeGitSummary,
		taskBranch,
		taskChangedFiles,
		skipTaskCheckoutConfirmation = false,
		skipHomeCheckoutConfirmation = false,
		taskId,
		baseRef,
		onCheckoutSuccess,
	} = options;

	const [isBranchPopoverOpen, setBranchPopoverOpen] = useState(false);
	const [checkoutDialogState, setCheckoutDialogState] = useState<CheckoutDialogState>({ type: "closed" });

	// Fetch git refs when popover opens
	const refsQueryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		const trpc = getRuntimeTrpcClient(workspaceId);
		const taskScope = taskId && baseRef ? { taskId, baseRef } : null;
		const payload = await trpc.workspace.getGitRefs.query(taskScope);
		if (!payload.ok) {
			throw new Error(payload.error ?? "Could not load git refs.");
		}
		return payload;
	}, [workspaceId, taskId, baseRef]);

	const refsQuery = useTrpcQuery<RuntimeGitRefsResponse>({
		enabled: isBranchPopoverOpen && workspaceId !== null,
		queryFn: refsQueryFn,
	});

	const branches = refsQuery.data?.refs ?? null;

	// Derive current branch from the underlying context (task or home),
	// not the view mode — branch_view shouldn't change which repo we're comparing against.
	const currentBranch = useMemo(() => {
		if (taskId) {
			return taskBranch ?? null;
		}
		return homeGitSummary?.currentBranch ?? null;
	}, [taskId, taskBranch, homeGitSummary]);

	// Derive worktree branches — map of branch name to task title
	const worktreeBranches = useMemo(() => {
		const map = new Map<string, string>();
		for (const column of board.columns.filter((c) => c.id !== "trash")) {
			for (const card of column.cards) {
				if (card.branch && card.useWorktree !== false) {
					map.set(card.branch, card.title ?? card.id);
				}
			}
		}
		return map;
	}, [board]);

	const handleSelectBranchView = useCallback(
		(ref: string) => {
			selectBranchView(ref);
		},
		[selectBranchView],
	);

	const performCheckout = useCallback(
		async (branch: string, scope: "home" | "task", checkoutTaskId?: string, checkoutBaseRef?: string) => {
			if (!workspaceId) {
				return;
			}
			try {
				const trpc = getRuntimeTrpcClient(workspaceId);
				const result = await trpc.workspace.checkoutGitBranch.mutate({
					branch,
					...(scope === "task" && checkoutTaskId ? { taskId: checkoutTaskId } : {}),
					...(checkoutBaseRef ? { baseRef: checkoutBaseRef } : {}),
				});
				if (result.ok) {
					toast.success(`Switched to ${branch}`);
					onCheckoutSuccess?.();
				} else {
					toast.error(result.error ?? `Failed to switch to ${branch}`);
				}
			} catch (error) {
				toast.error(`Checkout failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		[workspaceId, onCheckoutSuccess],
	);

	const handleCheckoutBranch = useCallback(
		(branch: string) => {
			// Determine scope from the underlying context, not the current view mode.
			// In branch_view, resolvedScope.type is "branch_view", but if taskId is set
			// the checkout should target the task worktree, not the home repo.
			const scope: "home" | "task" = taskId ? "task" : "home";
			const dirtyWorkingTree =
				scope === "task" ? (taskChangedFiles ?? 0) > 0 : (homeGitSummary?.changedFiles ?? 0) > 0;

			const result = resolveCheckoutDialogState({
				branch,
				scope,
				currentBranch,
				dirtyWorkingTree,
				worktreeBranches,
				skipTaskConfirmation: skipTaskCheckoutConfirmation,
				skipHomeConfirmation: skipHomeCheckoutConfirmation,
				taskId: taskId ?? undefined,
				baseRef: baseRef ?? undefined,
			});

			if (result === "skip") {
				void performCheckout(branch, scope, taskId ?? undefined, baseRef ?? undefined);
				return;
			}

			setCheckoutDialogState(result);
		},
		[
			currentBranch,
			worktreeBranches,
			taskChangedFiles,
			homeGitSummary,
			skipTaskCheckoutConfirmation,
			skipHomeCheckoutConfirmation,
			taskId,
			baseRef,
			performCheckout,
		],
	);

	const handleConfirmCheckout = useCallback(
		(branch: string, scope: "home" | "task", checkoutTaskId?: string, checkoutBaseRef?: string) => {
			void performCheckout(branch, scope, checkoutTaskId, checkoutBaseRef);
		},
		[performCheckout],
	);

	const closeCheckoutDialog = useCallback(() => {
		setCheckoutDialogState({ type: "closed" });
	}, []);

	return {
		isBranchPopoverOpen,
		setBranchPopoverOpen,
		branches,
		currentBranch,
		worktreeBranches,
		checkoutDialogState,
		closeCheckoutDialog,
		handleSelectBranchView,
		handleCheckoutBranch,
		handleConfirmCheckout,
	};
}
