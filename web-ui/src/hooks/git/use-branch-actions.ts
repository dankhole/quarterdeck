import { useCallback, useMemo, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import {
	type CheckoutDialogState,
	resolveCheckoutDialogState,
} from "@/components/detail-panels/checkout-confirmation-dialog";
import type { CreateBranchDialogState } from "@/components/detail-panels/create-branch-dialog";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitRef, RuntimeGitRefsResponse, RuntimeGitSyncSummary } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { setHomeGitSummary } from "@/stores/workspace-metadata-store";
import type { BoardData } from "@/types";
import { toErrorMessage } from "@/utils/to-error-message";

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
	/** Called when a merge results in conflicts (e.g. to switch to Git view). */
	onConflictDetected?: () => void;
}

export type DeleteBranchDialogState = { type: "closed" } | { type: "open"; branchName: string };
export type MergeBranchDialogState = { type: "closed" } | { type: "open"; branchName: string };

export interface UseBranchActionsResult {
	isBranchPopoverOpen: boolean;
	setBranchPopoverOpen: (open: boolean) => void;
	branches: RuntimeGitRef[] | null;
	currentBranch: string | null;
	worktreeBranches: Map<string, string>;
	checkoutDialogState: CheckoutDialogState;
	closeCheckoutDialog: () => void;
	createBranchDialogState: CreateBranchDialogState;
	handleCreateBranchFrom: (sourceRef: string) => void;
	closeCreateBranchDialog: () => void;
	handleBranchCreated: (branchName: string) => void;
	handleSelectBranchView: (ref: string) => void;
	handleCheckoutBranch: (branch: string) => void;
	handleConfirmCheckout: (branch: string, scope: "home" | "task", taskId?: string, baseRef?: string) => void;
	handleStashAndCheckout: () => void;
	isStashingAndCheckingOut: boolean;
	mergeBranchDialogState: MergeBranchDialogState;
	handleMergeBranch: (branch: string) => void;
	handleConfirmMergeBranch: () => void;
	closeMergeBranchDialog: () => void;
	deleteBranchDialogState: DeleteBranchDialogState;
	handleDeleteBranch: (branch: string) => void;
	handleConfirmDeleteBranch: () => void;
	closeDeleteBranchDialog: () => void;
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
		onConflictDetected,
	} = options;

	const [isBranchPopoverOpen, setBranchPopoverOpen] = useState(false);
	const [checkoutDialogState, setCheckoutDialogState] = useState<CheckoutDialogState>({ type: "closed" });
	const [isStashingAndCheckingOut, setIsStashingAndCheckingOut] = useState(false);

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
				// Update the status bar line diff immediately from the response summary
				if (scope === "home" && result.summary) {
					setHomeGitSummary(result.summary);
				}
				if (result.ok) {
					showAppToast({ intent: "success", message: `Switched to ${branch}` });
					onCheckoutSuccess?.();
				} else {
					showAppToast({ intent: "danger", message: result.error ?? `Failed to switch to ${branch}` });
				}
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: `Checkout failed: ${toErrorMessage(error)}`,
				});
			}
		},
		[workspaceId, onCheckoutSuccess],
	);

	// Merge branch dialog
	const [mergeBranchDialogState, setMergeBranchDialogState] = useState<MergeBranchDialogState>({ type: "closed" });

	const handleMergeBranch = useCallback((branch: string) => {
		setMergeBranchDialogState({ type: "open", branchName: branch });
	}, []);

	const closeMergeBranchDialog = useCallback(() => {
		setMergeBranchDialogState({ type: "closed" });
	}, []);

	const handleConfirmMergeBranch = useCallback(async () => {
		if (!workspaceId || mergeBranchDialogState.type !== "open") {
			return;
		}
		const { branchName } = mergeBranchDialogState;
		setMergeBranchDialogState({ type: "closed" });
		try {
			const trpc = getRuntimeTrpcClient(workspaceId);
			const result = await trpc.workspace.mergeBranch.mutate({
				branch: branchName,
				...(taskId ? { taskId } : {}),
				...(baseRef ? { baseRef } : {}),
			});
			if (result.ok) {
				showAppToast({
					intent: "success",
					message: `Merged ${branchName} into ${currentBranch ?? "current branch"}`,
				});
			} else if (result.conflictState) {
				showAppToast({ intent: "warning", message: "Merge has conflicts \u2014 opening resolver" });
				onConflictDetected?.();
			} else {
				showAppToast({ intent: "danger", message: result.error ?? `Failed to merge ${branchName}` });
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: `Merge failed: ${toErrorMessage(error)}`,
			});
		}
	}, [workspaceId, mergeBranchDialogState, taskId, baseRef, currentBranch, onConflictDetected]);

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

	const handleStashAndCheckout = useCallback(async () => {
		if (!workspaceId || checkoutDialogState.type !== "dirty_warning") {
			return;
		}
		const { branch, scope, taskId: checkoutTaskId, baseRef: checkoutBaseRef } = checkoutDialogState;
		const taskScope = taskId && baseRef ? { taskId, baseRef } : null;

		setIsStashingAndCheckingOut(true);
		try {
			const trpc = getRuntimeTrpcClient(workspaceId);
			const stashResult = await trpc.workspace.stashPush.mutate({ taskScope, paths: [], message: undefined });
			if (!stashResult.ok) {
				showAppToast({ intent: "danger", message: stashResult.error ?? "Failed to stash changes" });
				return;
			}
			// Stash succeeded — close dialog and perform checkout
			setCheckoutDialogState({ type: "closed" });
			await performCheckout(branch, scope, checkoutTaskId, checkoutBaseRef);
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: `Stash failed: ${toErrorMessage(error)}`,
			});
		} finally {
			setIsStashingAndCheckingOut(false);
		}
	}, [workspaceId, checkoutDialogState, taskId, baseRef, performCheckout]);

	const closeCheckoutDialog = useCallback(() => {
		setCheckoutDialogState({ type: "closed" });
	}, []);

	// Create branch dialog
	const [createBranchDialogState, setCreateBranchDialogState] = useState<CreateBranchDialogState>({ type: "closed" });

	const handleCreateBranchFrom = useCallback((sourceRef: string) => {
		setCreateBranchDialogState({ type: "open", sourceRef });
	}, []);

	const closeCreateBranchDialog = useCallback(() => {
		setCreateBranchDialogState({ type: "closed" });
	}, []);

	// Delete branch dialog
	const [deleteBranchDialogState, setDeleteBranchDialogState] = useState<DeleteBranchDialogState>({ type: "closed" });

	const handleDeleteBranch = useCallback((branch: string) => {
		setDeleteBranchDialogState({ type: "open", branchName: branch });
	}, []);

	const closeDeleteBranchDialog = useCallback(() => {
		setDeleteBranchDialogState({ type: "closed" });
	}, []);

	const refetchRefs = refsQuery.refetch;

	const handleConfirmDeleteBranch = useCallback(async () => {
		if (!workspaceId || deleteBranchDialogState.type !== "open") {
			return;
		}
		const { branchName } = deleteBranchDialogState;
		setDeleteBranchDialogState({ type: "closed" });
		try {
			const trpc = getRuntimeTrpcClient(workspaceId);
			const result = await trpc.workspace.deleteBranch.mutate({ branchName });
			if (result.ok) {
				showAppToast({ intent: "success", message: `Deleted branch ${branchName}` });
				void refetchRefs();
			} else {
				showAppToast({ intent: "danger", message: result.error ?? `Failed to delete ${branchName}` });
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: `Delete failed: ${toErrorMessage(error)}`,
			});
		}
	}, [workspaceId, deleteBranchDialogState, refetchRefs]);

	const handleBranchCreated = useCallback(
		(branchName: string) => {
			// Invalidate the refs query so the new branch appears in the list
			void refetchRefs();
			// Offer to check out the newly created branch
			handleCheckoutBranch(branchName);
		},
		[refetchRefs, handleCheckoutBranch],
	);

	return {
		isBranchPopoverOpen,
		setBranchPopoverOpen,
		branches,
		currentBranch,
		worktreeBranches,
		checkoutDialogState,
		closeCheckoutDialog,
		createBranchDialogState,
		handleCreateBranchFrom,
		closeCreateBranchDialog,
		handleBranchCreated,
		handleSelectBranchView,
		handleCheckoutBranch,
		handleConfirmCheckout,
		handleStashAndCheckout,
		isStashingAndCheckingOut,
		mergeBranchDialogState,
		handleMergeBranch,
		handleConfirmMergeBranch,
		closeMergeBranchDialog,
		deleteBranchDialogState,
		handleDeleteBranch,
		handleConfirmDeleteBranch,
		closeDeleteBranchDialog,
	};
}
