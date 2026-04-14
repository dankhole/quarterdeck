export enum LocalStorageKey {
	TaskStartInPlanMode = "quarterdeck.task-start-in-plan-mode",
	TaskAutoReviewEnabled = "quarterdeck.task-auto-review-enabled",
	TaskAutoReviewMode = "quarterdeck.task-auto-review-mode",
	TaskCreatePrimaryStartAction = "quarterdeck.task-create-primary-start-action",
	BottomTerminalPaneHeight = "quarterdeck.bottom-terminal-pane-height",
	DetailSidePanelRatio = "quarterdeck.detail-side-panel-ratio",
	DetailActivePanel = "quarterdeck.detail-active-panel",
	DetailMainView = "quarterdeck.detail-main-view",
	DetailSidebar = "quarterdeck.detail-sidebar",
	DetailLastSidebarTab = "quarterdeck.detail-last-sidebar-tab",
	DetailDiffFileTreePanelRatio = "quarterdeck.detail-diff-file-tree-panel-ratio",
	DetailExpandedDiffFileTreePanelRatio = "quarterdeck.detail-expanded-diff-file-tree-panel-ratio",
	DetailFileBrowserTreePanelRatio = "quarterdeck.detail-file-browser-tree-panel-ratio",
	DetailLastTaskTab = "quarterdeck.detail-last-task-tab",
	GitHistoryRefsPanelWidth = "quarterdeck.git-history-refs-panel-width",
	GitHistoryCommitsPanelWidth = "quarterdeck.git-history-commits-panel-width",
	GitDiffFileTreePanelRatio = "quarterdeck.git-diff-file-tree-panel-ratio",
	OnboardingDialogShown = "quarterdeck.onboarding.dialog.shown",
	OnboardingTipsDismissed = "quarterdeck.onboarding.tips.dismissed",
	PreferredOpenTarget = "quarterdeck.preferred-open-target",
	PromptShortcutLastLabel = "quarterdeck.prompt-shortcut-last-label",
	GitViewFileTreeRatio = "quarterdeck.git-view-file-tree-ratio",
	GitViewActiveTab = "quarterdeck.git-view-active-tab",
	SidebarPinned = "quarterdeck.sidebar-pinned",
	DebugLogPanelWidth = "quarterdeck.debug-log-panel-width",
	FileBrowserWordWrap = "quarterdeck.file-browser-word-wrap",
	FileBrowserMarkdownPreview = "quarterdeck.file-browser-markdown-preview",
	DebugLogDisabledTags = "quarterdeck.debug-log-disabled-tags",
	CompareIncludeUncommitted = "quarterdeck.compare-include-uncommitted",
	FileBrowserLastSelectedPath = "quarterdeck.file-browser-last-selected-path",
	GitViewLastSelectedPath = "quarterdeck.git-view-last-selected-path",
}

export const LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS = [
	LocalStorageKey.BottomTerminalPaneHeight,
	LocalStorageKey.DetailSidePanelRatio,
	LocalStorageKey.DetailDiffFileTreePanelRatio,
	LocalStorageKey.DetailExpandedDiffFileTreePanelRatio,
	LocalStorageKey.GitHistoryRefsPanelWidth,
	LocalStorageKey.GitHistoryCommitsPanelWidth,
	LocalStorageKey.GitDiffFileTreePanelRatio,
	LocalStorageKey.DetailFileBrowserTreePanelRatio,
	LocalStorageKey.GitViewFileTreeRatio,
	LocalStorageKey.DebugLogPanelWidth,
] as const;

function getLocalStorage(): Storage | null {
	if (typeof window === "undefined") {
		return null;
	}
	return window.localStorage;
}

export function readLocalStorageItem(key: LocalStorageKey): string | null {
	const storage = getLocalStorage();
	if (!storage) {
		return null;
	}
	try {
		return storage.getItem(key);
	} catch {
		return null;
	}
}

export function writeLocalStorageItem(key: LocalStorageKey, value: string): void {
	const storage = getLocalStorage();
	if (!storage) {
		return;
	}
	try {
		storage.setItem(key, value);
	} catch {
		// Ignore storage write failures.
	}
}

export function removeLocalStorageItem(key: LocalStorageKey): void {
	const storage = getLocalStorage();
	if (!storage) {
		return;
	}
	try {
		storage.removeItem(key);
	} catch {
		// Ignore storage removal failures.
	}
}

export function resetLayoutCustomizationLocalStorageItems(): void {
	for (const key of LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS) {
		removeLocalStorageItem(key);
	}
}
