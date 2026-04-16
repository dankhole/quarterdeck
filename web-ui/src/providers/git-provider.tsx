import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createContext, useCallback, useContext, useMemo, useRef } from "react";

import type { UseGitHistoryDataResult } from "@/components/git-history/use-git-history-data";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { type UseBranchActionsResult, useBranchActions } from "@/hooks/git/use-branch-actions";
import { useGitActions } from "@/hooks/git/use-git-actions";
import { type FileNavigation, useGitNavigation } from "@/hooks/git/use-git-navigation";
import type { GitViewCompareNavigation } from "@/hooks/git/use-git-view-compare";
import { type ResolvedScope, type ScopeMode, useScopeContext } from "@/hooks/git/use-scope-context";
import { type UseFileBrowserDataResult, useFileBrowserData } from "@/hooks/use-file-browser-data";
import { useBoardContext } from "@/providers/board-provider";
import { useProjectContext } from "@/providers/project-provider";
import { type MainViewId, type SidebarId, useCardDetailLayout } from "@/resize/use-card-detail-layout";
import type { RuntimeGitSyncAction } from "@/runtime/types";
import {
	useHomeGitSummaryValue,
	useTaskWorkspaceInfoValue,
	useTaskWorkspaceSnapshotValue,
} from "@/stores/workspace-metadata-store";

// ---------------------------------------------------------------------------
// Context value — git actions, git history, git navigation, scope context,
// branch actions, file browser data, card detail layout, and git navigation.
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

	// --- Git history toggle ---
	isGitHistoryOpen: boolean;
	setIsGitHistoryOpen: Dispatch<SetStateAction<boolean>>;
	handleToggleGitHistory: () => void;

	// --- useGitNavigation ---
	pendingCompareNavigation: GitViewCompareNavigation | null;
	pendingFileNavigation: FileNavigation | null;
	openGitCompare: (navigation: GitViewCompareNavigation) => void;
	clearPendingCompareNavigation: () => void;
	navigateToFile: (nav: FileNavigation) => void;
	clearPendingFileNavigation: () => void;
	navigateToGitView: () => void;

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

	// --- useCardDetailLayout ---
	mainView: MainViewId;
	sidebar: SidebarId | null;
	setMainView: (view: MainViewId, callbacks?: { setSelectedTaskId?: (id: string | null) => void }) => void;
	toggleSidebar: (id: SidebarId) => void;
	sidebarPinned: boolean;
	toggleSidebarPinned: () => void;
	visualMainView: MainViewId;
	visualSidebar: SidebarId | null;
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
	resetCardDetailLayoutToDefaults: () => void;

	// --- navigateToGitViewRef ---
	navigateToGitViewRef: React.MutableRefObject<(() => void) | null>;
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
	isGitHistoryOpen: boolean;
	setIsGitHistoryOpen: Dispatch<SetStateAction<boolean>>;
	children: ReactNode;
}

export function GitProvider({ isGitHistoryOpen, setIsGitHistoryOpen, children }: GitProviderProps): ReactNode {
	const {
		currentProjectId,
		runtimeProjectConfig,
		skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation,
		hasNoProjects,
		isProjectSwitching,
		refreshWorkspaceState,
	} = useProjectContext();

	const { board, selectedCard, selectedTaskId, setSelectedTaskId, sendTaskSessionInput, fetchTaskWorkspaceInfo } =
		useBoardContext();

	// Store subscriptions — duplicate calls are cheap (useSyncExternalStore).
	const selectedTaskWorkspaceInfo = useTaskWorkspaceInfoValue(selectedCard?.card.id, selectedCard?.card.baseRef);
	const selectedTaskWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(selectedCard?.card.id);
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

	// Ref-based callback: setMainView is declared later (useCardDetailLayout), but
	// onConflictDetected fires asynchronously from a mutation, never during render.
	const navigateToGitViewRef = useRef<(() => void) | null>(null);

	// --- useBranchActions (file browser) ---
	const fileBrowserBranchActions = useBranchActions({
		workspaceId: currentProjectId,
		board,
		selectBranchView: fileBrowserSelectBranchView,
		homeGitSummary,
		skipHomeCheckoutConfirmation,
		skipTaskCheckoutConfirmation,
		onCheckoutSuccess: fileBrowserReturnToContextual,
		onConflictDetected: () => navigateToGitViewRef.current?.(),
	});

	// --- useBranchActions (topbar) ---
	const topbarBranchActions = useBranchActions({
		workspaceId: currentProjectId,
		board,
		selectBranchView: topbarBranchViewNoop,
		homeGitSummary,
		taskBranch: selectedCard ? (selectedTaskWorkspaceInfo?.branch ?? selectedCard.card.branch ?? null) : undefined,
		taskChangedFiles: selectedCard ? (selectedTaskWorkspaceSnapshot?.changedFiles ?? 0) : undefined,
		taskId: selectedCard?.card.id ?? null,
		baseRef: selectedCard?.card.baseRef ?? null,
		skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation,
		onConflictDetected: () => navigateToGitViewRef.current?.(),
	});

	// --- topbarBranchLabel ---
	const topbarBranchLabel = useMemo(() => {
		if (selectedCard) {
			if (selectedTaskWorkspaceInfo?.branch) return selectedTaskWorkspaceInfo.branch;
			if (selectedTaskWorkspaceInfo?.isDetached)
				return selectedTaskWorkspaceInfo.headCommit?.substring(0, 7) ?? null;
			return selectedCard.card.branch ?? selectedTaskWorkspaceInfo?.headCommit?.substring(0, 7) ?? null;
		}
		return homeGitSummary?.currentBranch ?? null;
	}, [selectedCard, selectedTaskWorkspaceInfo, homeGitSummary]);

	// --- useFileBrowserData ---
	const homeFileBrowserData = useFileBrowserData({
		workspaceId: currentProjectId,
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
		fetchTaskWorkspaceInfo,
		isGitHistoryOpen,
		refreshWorkspaceState,
	});

	// --- handleToggleGitHistory ---
	const handleToggleGitHistory = useCallback(() => {
		if (hasNoProjects) return;
		setIsGitHistoryOpen((current) => !current);
	}, [hasNoProjects, setIsGitHistoryOpen]);

	// --- useCardDetailLayout ---
	const {
		mainView,
		sidebar,
		setMainView,
		toggleSidebar,
		sidebarPinned,
		toggleSidebarPinned,
		visualMainView,
		visualSidebar,
		sidePanelRatio,
		setSidePanelRatio,
		resetToDefaults: resetCardDetailLayoutToDefaults,
	} = useCardDetailLayout({ selectedTaskId, isProjectSwitching });

	// --- useGitNavigation ---
	const {
		pendingCompareNavigation,
		pendingFileNavigation,
		openGitCompare,
		clearPendingCompareNavigation,
		navigateToFile,
		clearPendingFileNavigation,
		navigateToGitView,
	} = useGitNavigation({ isGitHistoryOpen, setMainView, setSelectedTaskId });

	navigateToGitViewRef.current = navigateToGitView;

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
			isGitHistoryOpen,
			setIsGitHistoryOpen,
			handleToggleGitHistory,
			pendingCompareNavigation,
			pendingFileNavigation,
			openGitCompare,
			clearPendingCompareNavigation,
			navigateToFile,
			clearPendingFileNavigation,
			navigateToGitView,
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
			mainView,
			sidebar,
			setMainView,
			toggleSidebar,
			sidebarPinned,
			toggleSidebarPinned,
			visualMainView,
			visualSidebar,
			sidePanelRatio,
			setSidePanelRatio,
			resetCardDetailLayoutToDefaults,
			navigateToGitViewRef,
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
			isGitHistoryOpen,
			setIsGitHistoryOpen,
			handleToggleGitHistory,
			pendingCompareNavigation,
			pendingFileNavigation,
			openGitCompare,
			clearPendingCompareNavigation,
			navigateToFile,
			clearPendingFileNavigation,
			navigateToGitView,
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
			mainView,
			sidebar,
			setMainView,
			toggleSidebar,
			sidebarPinned,
			toggleSidebarPinned,
			visualMainView,
			visualSidebar,
			sidePanelRatio,
			setSidePanelRatio,
			resetCardDetailLayoutToDefaults,
			// navigateToGitViewRef is a ref — stable identity, never triggers re-render.
		],
	);

	return <GitContext.Provider value={value}>{children}</GitContext.Provider>;
}
