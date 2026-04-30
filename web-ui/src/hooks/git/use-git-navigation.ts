import { useCallback, useEffect, useState } from "react";
import type { GitViewCompareNavigation } from "@/hooks/git/use-git-view-compare";
import type { MainViewId } from "@/resize/use-card-detail-layout";

interface UseGitNavigationInput {
	isGitHistoryOpen: boolean;
	setMainView: (view: MainViewId, callbacks?: { setSelectedTaskId?: (id: string | null) => void }) => void;
	setSelectedTaskId: (id: string | null) => void;
}

export interface FileNavigation {
	targetView: "git" | "files";
	filePath: string;
	lineNumber?: number;
}

interface UseGitNavigationResult {
	pendingCompareNavigation: GitViewCompareNavigation | null;
	pendingFileNavigation: FileNavigation | null;
	openGitCompare: (navigation: GitViewCompareNavigation) => void;
	clearPendingCompareNavigation: () => void;
	navigateToFile: (nav: FileNavigation) => void;
	clearPendingFileNavigation: () => void;
	/** Stable callback that navigates to the git main view. Use for conflict handlers. */
	navigateToGitView: () => void;
}

/**
 * Manages git view navigation: compare navigation, file navigation, and the
 * auto-switch effect that opens the git main view when git history is toggled on.
 */
export function useGitNavigation({
	isGitHistoryOpen,
	setMainView,
	setSelectedTaskId,
}: UseGitNavigationInput): UseGitNavigationResult {
	const [pendingCompareNavigation, setPendingCompareNavigation] = useState<GitViewCompareNavigation | null>(null);
	const [pendingFileNavigation, setPendingFileNavigation] = useState<FileNavigation | null>(null);

	const navigateToGitView = useCallback(() => {
		setMainView("git", { setSelectedTaskId });
	}, [setMainView, setSelectedTaskId]);

	/** Navigate to the git view's Compare tab with pre-set branch parameters. */
	const openGitCompare = useCallback(
		(navigation: GitViewCompareNavigation) => {
			setPendingCompareNavigation(navigation);
			setMainView("git", { setSelectedTaskId });
		},
		[setMainView, setSelectedTaskId],
	);
	const clearPendingCompareNavigation = useCallback(() => setPendingCompareNavigation(null), []);

	/** Navigate to a specific file in the git diff viewer or file browser from the commit panel. */
	const navigateToFile = useCallback(
		(nav: FileNavigation) => {
			setPendingFileNavigation(nav);
			setMainView(nav.targetView, { setSelectedTaskId });
		},
		[setMainView, setSelectedTaskId],
	);
	const clearPendingFileNavigation = useCallback(() => setPendingFileNavigation(null), []);

	// Auto-switch to git main view when git history is toggled on from the branch status control.
	useEffect(() => {
		if (isGitHistoryOpen) {
			setMainView("git", { setSelectedTaskId });
		}
	}, [isGitHistoryOpen, setMainView, setSelectedTaskId]);

	return {
		pendingCompareNavigation,
		pendingFileNavigation,
		openGitCompare,
		clearPendingCompareNavigation,
		navigateToFile,
		clearPendingFileNavigation,
		navigateToGitView,
	};
}
