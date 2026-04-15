import { createContext, useContext } from "react";

import type { UseGitHistoryDataResult } from "@/components/git-history/use-git-history-data";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import type { FileNavigation } from "@/hooks/use-git-navigation";
import type { GitViewCompareNavigation } from "@/hooks/use-git-view-compare";
import type { ResolvedScope, ScopeMode } from "@/hooks/use-scope-context";
import type { RuntimeGitSyncAction } from "@/runtime/types";

// ---------------------------------------------------------------------------
// Context value — git actions, git history, git navigation, scope context,
// and branch action state.
//
// The value is constructed in App.tsx and provided inline via
// <GitContext.Provider>. This file owns the context shape and consumer
// hook so child components can read git state without prop drilling.
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
}

export const GitContext = createContext<GitContextValue | null>(null);

export function useGitContext(): GitContextValue {
	const ctx = useContext(GitContext);
	if (!ctx) {
		throw new Error("useGitContext must be used within a GitContext.Provider");
	}
	return ctx;
}
