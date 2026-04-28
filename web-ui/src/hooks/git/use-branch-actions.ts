import { useCallback, useMemo, useState } from "react";
import {
	type CheckoutDialogState,
	type CreateBranchDialogState,
	resolveCheckoutDialogState,
} from "@/components/git/panels";
import { showGitErrorToast, showGitSuccessToast, showGitWarningToast } from "@/hooks/git/git-actions";
import { areGitRefsResponsesEqual } from "@/runtime/query-equality";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitRef, RuntimeGitRefsResponse, RuntimeGitSyncSummary } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { setHomeGitSummary } from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";
import { useLoadingGuard } from "@/utils/react-use";
import { toErrorMessage } from "@/utils/to-error-message";

interface UseBranchActionsOptions {
	projectId: string | null;
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
export type RebaseBranchDialogState = { type: "closed" } | { type: "open"; onto: string };
export type RenameBranchDialogState = { type: "closed" } | { type: "open"; branchName: string };
export type ResetToRefDialogState = { type: "closed" } | { type: "open"; ref: string };

export interface UseBranchActionsResult {
	isBranchPopoverOpen: boolean;
	setBranchPopoverOpen: (open: boolean) => void;
	branches: RuntimeGitRef[] | null;
	isLoadingBranches: boolean;
	requestBranches: () => void;
	refetchBranches: () => Promise<unknown>;
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
	rebaseBranchDialogState: RebaseBranchDialogState;
	handleRebaseBranch: (onto: string) => void;
	handleConfirmRebaseBranch: () => void;
	closeRebaseBranchDialog: () => void;
	renameBranchDialogState: RenameBranchDialogState;
	handleRenameBranch: (branch: string) => void;
	handleConfirmRenameBranch: (newName: string) => void;
	closeRenameBranchDialog: () => void;
	resetToRefDialogState: ResetToRefDialogState;
	handleResetToRef: (ref: string) => void;
	handleConfirmResetToRef: () => void;
	closeResetToRefDialog: () => void;
}

export function useBranchActions(options: UseBranchActionsOptions): UseBranchActionsResult {
	const {
		projectId,
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
	const [isRefsRequested, setIsRefsRequested] = useState(false);
	const [checkoutDialogState, setCheckoutDialogState] = useState<CheckoutDialogState>({ type: "closed" });
	const stashAndCheckoutGuard = useLoadingGuard();
	const isStashingAndCheckingOut = stashAndCheckoutGuard.isLoading;

	const wrappedSetBranchPopoverOpen = useCallback((open: boolean) => {
		setBranchPopoverOpen(open);
		if (open) setIsRefsRequested(true);
	}, []);

	const requestBranches = useCallback(() => {
		setIsRefsRequested(true);
	}, []);

	// Fetch git refs when any branch popover opens (main popover or base ref dropdown)
	const refsQueryFn = useCallback(async () => {
		if (!projectId) {
			throw new Error("Missing project.");
		}
		const trpc = getRuntimeTrpcClient(projectId);
		const taskScope = taskId && baseRef ? { taskId, baseRef } : null;
		const payload = await trpc.project.getGitRefs.query(taskScope);
		if (!payload.ok) {
			throw new Error(payload.error ?? "Could not load git refs.");
		}
		return payload;
	}, [projectId, taskId, baseRef]);

	const refsQuery = useTrpcQuery<RuntimeGitRefsResponse>({
		enabled: (isBranchPopoverOpen || isRefsRequested) && projectId !== null,
		queryFn: refsQueryFn,
		isDataEqual: areGitRefsResponsesEqual,
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
			if (!projectId) {
				return;
			}
			try {
				const trpc = getRuntimeTrpcClient(projectId);
				const result = await trpc.project.checkoutGitBranch.mutate({
					branch,
					...(scope === "task" && checkoutTaskId ? { taskId: checkoutTaskId } : {}),
					...(checkoutBaseRef ? { baseRef: checkoutBaseRef } : {}),
				});
				// Update the status bar line diff immediately from the response summary
				if (scope === "home" && result.summary) {
					setHomeGitSummary(result.summary);
				}
				if (result.ok) {
					showGitSuccessToast(`Switched to ${branch}`);
					onCheckoutSuccess?.();
				} else {
					showGitErrorToast(result.error ?? `Failed to switch to ${branch}`);
				}
			} catch (error) {
				showGitErrorToast(`Checkout failed: ${toErrorMessage(error)}`);
			}
		},
		[projectId, onCheckoutSuccess],
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
		if (!projectId || mergeBranchDialogState.type !== "open") {
			return;
		}
		const { branchName } = mergeBranchDialogState;
		setMergeBranchDialogState({ type: "closed" });
		try {
			const trpc = getRuntimeTrpcClient(projectId);
			const result = await trpc.project.mergeBranch.mutate({
				branch: branchName,
				...(taskId ? { taskId } : {}),
				...(baseRef ? { baseRef } : {}),
			});
			if (result.ok) {
				showGitSuccessToast(`Merged ${branchName} into ${currentBranch ?? "current branch"}`);
			} else if (result.conflictState) {
				showGitWarningToast("Merge has conflicts \u2014 opening resolver");
				onConflictDetected?.();
			} else {
				showGitErrorToast(result.error ?? `Failed to merge ${branchName}`);
			}
		} catch (error) {
			showGitErrorToast(`Merge failed: ${toErrorMessage(error)}`);
		}
	}, [projectId, mergeBranchDialogState, taskId, baseRef, currentBranch, onConflictDetected]);

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
		if (!projectId || checkoutDialogState.type !== "dirty_warning") {
			return;
		}
		const { branch, scope, taskId: checkoutTaskId, baseRef: checkoutBaseRef } = checkoutDialogState;
		const taskScope = taskId && baseRef ? { taskId, baseRef } : null;

		await stashAndCheckoutGuard.run(async () => {
			try {
				const trpc = getRuntimeTrpcClient(projectId);
				const stashResult = await trpc.project.stashPush.mutate({ taskScope, paths: [], message: undefined });
				if (!stashResult.ok) {
					showGitErrorToast(stashResult.error ?? "Failed to stash changes");
					return;
				}
				setCheckoutDialogState({ type: "closed" });
				await performCheckout(branch, scope, checkoutTaskId, checkoutBaseRef);
			} catch (error) {
				showGitErrorToast(`Stash failed: ${toErrorMessage(error)}`);
			}
		});
	}, [projectId, checkoutDialogState, taskId, baseRef, performCheckout]);

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
		if (!projectId || deleteBranchDialogState.type !== "open") {
			return;
		}
		const { branchName } = deleteBranchDialogState;
		setDeleteBranchDialogState({ type: "closed" });
		try {
			const trpc = getRuntimeTrpcClient(projectId);
			const result = await trpc.project.deleteBranch.mutate({ branchName });
			if (result.ok) {
				showGitSuccessToast(`Deleted branch ${branchName}`);
				void refetchRefs();
			} else {
				showGitErrorToast(result.error ?? `Failed to delete ${branchName}`);
			}
		} catch (error) {
			showGitErrorToast(`Delete failed: ${toErrorMessage(error)}`);
		}
	}, [projectId, deleteBranchDialogState, refetchRefs]);

	const handleBranchCreated = useCallback(
		(branchName: string) => {
			// Invalidate the refs query so the new branch appears in the list
			void refetchRefs();
			// Offer to check out the newly created branch
			handleCheckoutBranch(branchName);
		},
		[refetchRefs, handleCheckoutBranch],
	);

	// Rebase branch dialog
	const [rebaseBranchDialogState, setRebaseBranchDialogState] = useState<RebaseBranchDialogState>({ type: "closed" });

	const handleRebaseBranch = useCallback((onto: string) => {
		setRebaseBranchDialogState({ type: "open", onto });
	}, []);

	const closeRebaseBranchDialog = useCallback(() => {
		setRebaseBranchDialogState({ type: "closed" });
	}, []);

	const handleConfirmRebaseBranch = useCallback(async () => {
		if (!projectId || rebaseBranchDialogState.type !== "open") {
			return;
		}
		const { onto } = rebaseBranchDialogState;
		setRebaseBranchDialogState({ type: "closed" });
		try {
			const trpc = getRuntimeTrpcClient(projectId);
			const result = await trpc.project.rebaseBranch.mutate({
				onto,
				...(taskId ? { taskId } : {}),
				...(baseRef ? { baseRef } : {}),
			});
			if (result.ok) {
				showGitSuccessToast(`Rebased onto ${onto}`);
			} else if (result.conflictState) {
				showGitWarningToast("Rebase has conflicts \u2014 opening resolver");
				onConflictDetected?.();
			} else {
				showGitErrorToast(result.error ?? `Failed to rebase onto ${onto}`);
			}
		} catch (error) {
			showGitErrorToast(`Rebase failed: ${toErrorMessage(error)}`);
		}
	}, [projectId, rebaseBranchDialogState, taskId, baseRef, onConflictDetected]);

	// Rename branch dialog
	const [renameBranchDialogState, setRenameBranchDialogState] = useState<RenameBranchDialogState>({ type: "closed" });

	const handleRenameBranch = useCallback((branch: string) => {
		setRenameBranchDialogState({ type: "open", branchName: branch });
	}, []);

	const closeRenameBranchDialog = useCallback(() => {
		setRenameBranchDialogState({ type: "closed" });
	}, []);

	const handleConfirmRenameBranch = useCallback(
		async (newName: string) => {
			if (!projectId || renameBranchDialogState.type !== "open") {
				return;
			}
			const { branchName: oldName } = renameBranchDialogState;
			setRenameBranchDialogState({ type: "closed" });
			try {
				const trpc = getRuntimeTrpcClient(projectId);
				const result = await trpc.project.renameBranch.mutate({ oldName, newName });
				if (result.ok) {
					showGitSuccessToast(`Renamed ${oldName} to ${newName}`);
					void refetchRefs();
				} else {
					showGitErrorToast(result.error ?? `Failed to rename ${oldName}`);
				}
			} catch (error) {
				showGitErrorToast(`Rename failed: ${toErrorMessage(error)}`);
			}
		},
		[projectId, renameBranchDialogState, refetchRefs],
	);

	// Reset to ref dialog
	const [resetToRefDialogState, setResetToRefDialogState] = useState<ResetToRefDialogState>({ type: "closed" });

	const handleResetToRef = useCallback((ref: string) => {
		setResetToRefDialogState({ type: "open", ref });
	}, []);

	const closeResetToRefDialog = useCallback(() => {
		setResetToRefDialogState({ type: "closed" });
	}, []);

	const handleConfirmResetToRef = useCallback(async () => {
		if (!projectId || resetToRefDialogState.type !== "open") {
			return;
		}
		const { ref } = resetToRefDialogState;
		setResetToRefDialogState({ type: "closed" });
		try {
			const trpc = getRuntimeTrpcClient(projectId);
			const result = await trpc.project.resetToRef.mutate({
				ref,
				...(taskId ? { taskId } : {}),
				...(baseRef ? { baseRef } : {}),
			});
			if (result.ok) {
				showGitSuccessToast(`Reset to ${ref}`);
			} else {
				showGitErrorToast(result.error ?? `Failed to reset to ${ref}`);
			}
		} catch (error) {
			showGitErrorToast(`Reset failed: ${toErrorMessage(error)}`);
		}
	}, [projectId, resetToRefDialogState, taskId, baseRef]);

	return {
		isBranchPopoverOpen,
		setBranchPopoverOpen: wrappedSetBranchPopoverOpen,
		branches,
		isLoadingBranches: refsQuery.isLoading,
		requestBranches,
		refetchBranches: refsQuery.refetch,
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
		rebaseBranchDialogState,
		handleRebaseBranch,
		handleConfirmRebaseBranch,
		closeRebaseBranchDialog,
		renameBranchDialogState,
		handleRenameBranch,
		handleConfirmRenameBranch,
		closeRenameBranchDialog,
		resetToRefDialogState,
		handleResetToRef,
		handleConfirmResetToRef,
		closeResetToRefDialog,
	};
}
