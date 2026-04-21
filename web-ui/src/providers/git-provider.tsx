import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

import type { UseGitHistoryDataResult } from "@/components/git/history";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import {
	type ResolvedScope,
	type ScopeMode,
	type UseBranchActionsResult,
	type UseFileBrowserDataResult,
	useBranchActions,
	useFileBrowserData,
	useGitActions,
	useScopeContext,
} from "@/hooks/git";
import { useBoardContext } from "@/providers/board-provider";
import { useProjectContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { useSurfaceNavigationContext } from "@/providers/surface-navigation-provider";
import type { RuntimeGitSyncAction } from "@/runtime/types";
import {
	useHomeGitSummaryValue,
	useTaskWorktreeInfoValue,
	useTaskWorktreeSnapshotValue,
} from "@/stores/project-metadata-store";

// ---------------------------------------------------------------------------
// Context value — git actions, git history data, scope context, branch
// actions, and file browser data.
//
// The value is constructed by <GitProvider> and provided via
// <GitContext.Provider>. Child components read git state via useGitContext().
// ---------------------------------------------------------------------------

interface TaskGitActionLoadingState {
	commitSource: "card" | "agent" | null;
	prSource: "card" | "agent" | null;
}

export interface GitContextValue {
	// --- useGitActions ---
	runningGitAction: RuntimeGitSyncAction | null;
	gitActionError: {
		action: RuntimeGitSyncAction;
		message: string;
		output: string;
		dirtyTree?: boolean;
	} | null;
	gitActionErrorTitle: string;
	clearGitActionError: () => void;
	gitHistory: UseGitHistoryDataResult;
	gitHistoryTaskScope: { taskId: string; baseRef: string } | null;
	runGitAction: (
		action: RuntimeGitSyncAction,
		taskScope?: { taskId: string; baseRef: string } | null,
		branch?: string | null,
	) => Promise<void>;
	switchHomeBranch: (branch: string) => Promise<void>;
	resetGitActionState: () => void;
	taskGitActionLoadingByTaskId: Record<string, TaskGitActionLoadingState>;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	onStashAndRetry: (() => void) | undefined;
	isStashAndRetryingPull: boolean;

	// --- Home file browser scope context ---
	fileBrowserScopeMode: ScopeMode;
	fileBrowserResolvedScope: ResolvedScope | null;
	fileBrowserSwitchToHome: () => void;
	fileBrowserReturnToContextual: () => void;
	fileBrowserSelectBranchView: (ref: string) => void;

	// --- Derived ---
	gitSyncTaskScope: { taskId: string; baseRef: string } | undefined;

	// --- useBranchActions (two instances) ---
	fileBrowserBranchActions: UseBranchActionsResult;
	topbarBranchActions: UseBranchActionsResult;
	topbarBranchLabel: string | null;

	// --- useFileBrowserData ---
	homeFileBrowserData: UseFileBrowserDataResult;
}

export const GitContext = createContext<GitContextValue | null>(null);

export function useGitContext(): GitContextValue {
	const ctx = useContext(GitContext);
	if (!ctx) {
		throw new Error("useGitContext must be used within a GitContext.Provider");
	}
	return ctx;
}

// ---------------------------------------------------------------------------
// GitProvider — calls all git-related hooks and provides the context value.
// ---------------------------------------------------------------------------

/** Noop for useBranchActions selectBranchView — the topbar pill uses checkout as its primary action. */
const topbarBranchViewNoop = (_ref: string) => {};

interface GitProviderProps {
	children: ReactNode;
}

export function GitProvider({ children }: GitProviderProps): ReactNode {
	const { currentProjectId, refreshProjectState } = useProjectContext();
	const { runtimeProjectConfig, skipTaskCheckoutConfirmation, skipHomeCheckoutConfirmation } =
		useProjectRuntimeContext();

	const { board, selectedCard, sendTaskSessionInput, fetchTaskWorktreeInfo } = useBoardContext();
	const { isGitHistoryOpen, navigateToGitView } = useSurfaceNavigationContext();

	// Store subscriptions — duplicate calls are cheap (useSyncExternalStore).
	const selectedTaskWorktreeInfo = useTaskWorktreeInfoValue(selectedCard?.card.id, selectedCard?.card.baseRef);
	const selectedTaskWorktreeSnapshot = useTaskWorktreeSnapshotValue(selectedCard?.card.id);
	const homeGitSummary = useHomeGitSummaryValue();

	// --- useScopeContext ---
	const {
		scopeMode: fileBrowserScopeMode,
		resolvedScope: fileBrowserResolvedScope,
		switchToHome: fileBrowserSwitchToHome,
		returnToContextual: fileBrowserReturnToContextual,
		selectBranchView: fileBrowserSelectBranchView,
	} = useScopeContext({
		selectedTaskId: null,
		selectedCard: null,
		currentProjectId,
	});

	// --- useBranchActions (file browser) ---
	const fileBrowserBranchActions = useBranchActions({
		projectId: currentProjectId,
		board,
		selectBranchView: fileBrowserSelectBranchView,
		homeGitSummary,
		skipHomeCheckoutConfirmation,
		skipTaskCheckoutConfirmation,
		onCheckoutSuccess: fileBrowserReturnToContextual,
		onConflictDetected: navigateToGitView,
	});

	// --- useBranchActions (topbar) ---
	const topbarBranchActions = useBranchActions({
		projectId: currentProjectId,
		board,
		selectBranchView: topbarBranchViewNoop,
		homeGitSummary,
		taskBranch: selectedCard ? (selectedTaskWorktreeInfo?.branch ?? selectedCard.card.branch ?? null) : undefined,
		taskChangedFiles: selectedCard ? (selectedTaskWorktreeSnapshot?.changedFiles ?? 0) : undefined,
		taskId: selectedCard?.card.id ?? null,
		baseRef: selectedCard?.card.baseRef ?? null,
		skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation,
		onConflictDetected: navigateToGitView,
	});

	// --- topbarBranchLabel ---
	const topbarBranchLabel = useMemo(() => {
		if (selectedCard) {
			if (selectedTaskWorktreeInfo?.branch) return selectedTaskWorktreeInfo.branch;
			if (selectedTaskWorktreeInfo?.isDetached) return selectedTaskWorktreeInfo.headCommit?.substring(0, 7) ?? null;
			return selectedCard.card.branch ?? selectedTaskWorktreeInfo?.headCommit?.substring(0, 7) ?? null;
		}
		return homeGitSummary?.currentBranch ?? null;
	}, [selectedCard, selectedTaskWorktreeInfo, homeGitSummary]);

	// --- useFileBrowserData ---
	const homeFileBrowserData = useFileBrowserData({
		projectId: currentProjectId,
		taskId: fileBrowserResolvedScope?.type === "task" ? fileBrowserResolvedScope.taskId : null,
		baseRef: fileBrowserResolvedScope?.type === "task" ? fileBrowserResolvedScope.baseRef : undefined,
		ref: fileBrowserResolvedScope?.type === "branch_view" ? fileBrowserResolvedScope.ref : undefined,
	});

	// --- useGitActions ---
	const {
		runningGitAction,
		gitActionError,
		gitActionErrorTitle,
		clearGitActionError,
		gitHistory,
		gitHistoryTaskScope,
		runGitAction,
		switchHomeBranch,
		resetGitActionState,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
		onStashAndRetry,
		isStashAndRetryingPull,
	} = useGitActions({
		currentProjectId,
		board,
		selectedCard,
		runtimeProjectConfig,
		sendTaskSessionInput,
		fetchTaskWorktreeInfo,
		isGitHistoryOpen,
		refreshProjectState,
	});

	// --- gitSyncTaskScope ---
	const gitSyncTaskScope = useMemo(
		() => (selectedCard ? { taskId: selectedCard.card.id, baseRef: selectedCard.card.baseRef } : undefined),
		[selectedCard?.card.id, selectedCard?.card.baseRef],
	);

	// --- Context value ---
	const value = useMemo<GitContextValue>(
		() => ({
			runningGitAction,
			gitActionError,
			gitActionErrorTitle,
			clearGitActionError,
			gitHistory,
			gitHistoryTaskScope,
			runGitAction,
			switchHomeBranch,
			resetGitActionState,
			taskGitActionLoadingByTaskId,
			runAutoReviewGitAction,
			onStashAndRetry,
			isStashAndRetryingPull,
			fileBrowserScopeMode,
			fileBrowserResolvedScope,
			fileBrowserSwitchToHome,
			fileBrowserReturnToContextual,
			fileBrowserSelectBranchView,
			gitSyncTaskScope,
			fileBrowserBranchActions,
			topbarBranchActions,
			topbarBranchLabel,
			homeFileBrowserData,
		}),
		[
			runningGitAction,
			gitActionError,
			gitActionErrorTitle,
			clearGitActionError,
			gitHistory,
			gitHistoryTaskScope,
			runGitAction,
			switchHomeBranch,
			resetGitActionState,
			taskGitActionLoadingByTaskId,
			runAutoReviewGitAction,
			onStashAndRetry,
			isStashAndRetryingPull,
			fileBrowserScopeMode,
			fileBrowserResolvedScope,
			fileBrowserSwitchToHome,
			fileBrowserReturnToContextual,
			fileBrowserSelectBranchView,
			gitSyncTaskScope,
			fileBrowserBranchActions,
			topbarBranchActions,
			topbarBranchLabel,
			homeFileBrowserData,
		],
	);

	return <GitContext.Provider value={value}>{children}</GitContext.Provider>;
}
