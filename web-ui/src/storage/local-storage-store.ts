import { isSharedUiPreferenceKey, sharedUiPreferences } from "@/storage/shared-ui-preferences";
export enum LocalStorageKey {
	ProjectGroupsCollapsed = "quarterdeck.project-groups-collapsed",
	TaskCreatePrimaryStartAction = "quarterdeck.task-create-primary-start-action",
	TaskCreateLastAgentId = "quarterdeck.task-create-last-agent-id",
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
	CommitPanelControlsHeight = "quarterdeck.commit-panel-controls-height",
	OnboardingDialogShown = "quarterdeck.onboarding.dialog.shown",
	OnboardingTipsDismissed = "quarterdeck.onboarding.tips.dismissed",
	SidebarHelpExpanded = "quarterdeck.sidebar-help-expanded",
	PreferredOpenTarget = "quarterdeck.preferred-open-target",
	PromptShortcutLastLabel = "quarterdeck.prompt-shortcut-last-label",
	GitViewFileTreeRatio = "quarterdeck.git-view-file-tree-ratio",
	GitViewActiveTab = "quarterdeck.git-view-active-tab",
	DiagnosticsPanelWidth = "quarterdeck.diagnostics-panel-width",
	FileBrowserWordWrap = "quarterdeck.file-browser-word-wrap",
	FileBrowserMarkdownPreview = "quarterdeck.file-browser-markdown-preview",
	CompareIncludeUncommitted = "quarterdeck.compare-include-uncommitted",
	CompareThreeDotDiff = "quarterdeck.compare-three-dot-diff",
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
	LocalStorageKey.CommitPanelControlsHeight,
	LocalStorageKey.DetailFileBrowserTreePanelRatio,
	LocalStorageKey.GitViewFileTreeRatio,
	LocalStorageKey.DiagnosticsPanelWidth,
] as const;

export function getOptionalLocalStorage(): Storage | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

const localListeners = new Set<() => void>();
export function subscribePreferenceStorage(listener: () => void): () => void {
	localListeners.add(listener);
	const unsubscribe = sharedUiPreferences.subscribe(listener);
	return () => {
		localListeners.delete(listener);
		unsubscribe();
	};
}

export function readLocalStorageItem(key: string): string | null {
	if (sharedUiPreferences.active && isSharedUiPreferenceKey(key)) return sharedUiPreferences.read(key);
	const storage = getOptionalLocalStorage();
	if (!storage) {
		return null;
	}
	try {
		return storage.getItem(key);
	} catch {
		return null;
	}
}

export function writeLocalStorageItem(key: string, value: string): void {
	if (sharedUiPreferences.active && isSharedUiPreferenceKey(key)) {
		sharedUiPreferences.write(key, value);
		return;
	}
	const storage = getOptionalLocalStorage();
	if (!storage) {
		return;
	}
	try {
		storage.setItem(key, value);
		for (const listener of localListeners) listener();
	} catch {
		// Ignore storage write failures.
	}
}

export function removeLocalStorageItem(key: string): void {
	if (sharedUiPreferences.active && isSharedUiPreferenceKey(key)) {
		sharedUiPreferences.write(key, null);
		return;
	}
	const storage = getOptionalLocalStorage();
	if (!storage) {
		return;
	}
	try {
		storage.removeItem(key);
		for (const listener of localListeners) listener();
	} catch {
		// Ignore storage removal failures.
	}
}

export function resetLayoutCustomizationLocalStorageItems(): void {
	for (const key of LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS) {
		removeLocalStorageItem(key);
	}
}
