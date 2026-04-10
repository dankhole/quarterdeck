import { useCallback, useEffect, useRef, useState } from "react";

import { clampBetween } from "@/resize/resize-persistence";
import {
	getResizePreferenceDefaultValue,
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

export type TaskTabId = "task_column" | "changes" | "files";
export type SidebarTabId = "home" | "projects" | TaskTabId;

const SIDE_PANEL_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailSidePanelRatio,
	defaultValue: 0.15,
	normalize: (value) => clampBetween(value, 0.14, 0.8),
};

const COLLAPSED_DIFF_FILE_TREE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailDiffFileTreePanelRatio,
	defaultValue: 0.3333,
	normalize: (value) => clampBetween(value, 0.12, 0.6),
};

const EXPANDED_DIFF_FILE_TREE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailExpandedDiffFileTreePanelRatio,
	defaultValue: 0.16,
	normalize: (value) => clampBetween(value, 0.12, 0.6),
};

const COLLAPSED_FILE_BROWSER_TREE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailFileBrowserTreePanelRatio,
	defaultValue: 0.25,
	normalize: (value) => clampBetween(value, 0.12, 0.6),
};

const EXPANDED_FILE_BROWSER_TREE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailExpandedFileBrowserTreePanelRatio,
	defaultValue: 0.16,
	normalize: (value) => clampBetween(value, 0.12, 0.6),
};

// --- localStorage loaders / persisters ---

export function loadActiveTab(): SidebarTabId | null {
	const stored = readLocalStorageItem(LocalStorageKey.DetailActivePanel);
	// Migration: "quarterdeck" was the old Task Column panel ID — map to "home"
	// so existing users land on the Home tab after upgrade.
	if (stored === "quarterdeck" || stored === "home") return "home";
	if (stored === "projects") return "projects";
	if (stored === "task_column" || stored === "changes" || stored === "files") return stored;
	if (stored === "") return null; // panel was collapsed
	return "home"; // default for new installs
}

function persistActiveTab(tab: SidebarTabId | null): SidebarTabId | null {
	writeLocalStorageItem(LocalStorageKey.DetailActivePanel, tab ?? "");
	return tab;
}

export function loadLastTaskTab(): TaskTabId {
	const stored = readLocalStorageItem(LocalStorageKey.DetailLastTaskTab);
	if (stored === "task_column" || stored === "changes" || stored === "files") return stored;
	return "task_column"; // default
}

function persistLastTaskTab(tab: TaskTabId): TaskTabId {
	writeLocalStorageItem(LocalStorageKey.DetailLastTaskTab, tab);
	return tab;
}

export function useCardDetailLayout({
	isDiffExpanded,
	isFileBrowserExpanded,
	selectedTaskId,
}: {
	isDiffExpanded: boolean;
	isFileBrowserExpanded: boolean;
	selectedTaskId: string | null;
}): {
	activeTab: SidebarTabId | null;
	setActiveTab: (tab: SidebarTabId | null) => void;
	lastTaskTab: TaskTabId;
	handleTabChange: (tab: SidebarTabId, callbacks?: { setSelectedTaskId?: (id: string | null) => void }) => void;
	visualActiveTab: SidebarTabId;
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
	detailDiffFileTreeRatio: number;
	setDetailDiffFileTreeRatio: (ratio: number) => void;
	detailFileBrowserTreeRatio: number;
	setDetailFileBrowserTreeRatio: (ratio: number) => void;
	resetToDefaults: () => void;
} {
	const [activeTab, setActiveTabState] = useState<SidebarTabId | null>(loadActiveTab);
	const [lastTaskTab, setLastTaskTabState] = useState<TaskTabId>(loadLastTaskTab);
	const [sidePanelRatio, setSidePanelRatioState] = useState(() => loadResizePreference(SIDE_PANEL_RATIO_PREFERENCE));
	const [collapsedDetailDiffFileTreeRatio, setCollapsedDetailDiffFileTreeRatioState] = useState(() =>
		loadResizePreference(COLLAPSED_DIFF_FILE_TREE_RATIO_PREFERENCE),
	);
	const [expandedDetailDiffFileTreeRatio, setExpandedDetailDiffFileTreeRatioState] = useState(() =>
		loadResizePreference(EXPANDED_DIFF_FILE_TREE_RATIO_PREFERENCE),
	);
	const [collapsedFileBrowserTreeRatio, setCollapsedFileBrowserTreeRatioState] = useState(() =>
		loadResizePreference(COLLAPSED_FILE_BROWSER_TREE_RATIO_PREFERENCE),
	);
	const [expandedFileBrowserTreeRatio, setExpandedFileBrowserTreeRatioState] = useState(() =>
		loadResizePreference(EXPANDED_FILE_BROWSER_TREE_RATIO_PREFERENCE),
	);

	const setActiveTab = useCallback((tab: SidebarTabId | null) => {
		setActiveTabState(persistActiveTab(tab));
	}, []);

	const setLastTaskTab = useCallback((tab: TaskTabId) => {
		setLastTaskTabState(persistLastTaskTab(tab));
	}, []);

	const handleTabChange = useCallback(
		(tab: SidebarTabId, callbacks?: { setSelectedTaskId?: (id: string | null) => void }) => {
			if (tab === activeTab) {
				// Toggle side panel closed
				setActiveTab(null);
				return;
			}
			if (tab === "home") {
				setActiveTab("home");
				// Deselect task if one is selected
				callbacks?.setSelectedTaskId?.(null);
				return;
			}
			if (tab === "projects") {
				// Open project sidebar without deselecting the current task
				setActiveTab("projects");
				return;
			}
			// Task-tied tab
			setActiveTab(tab);
			setLastTaskTab(tab);
		},
		[activeTab, setActiveTab, setLastTaskTab],
	);

	// Derive the visual highlight indicator for the sidebar toolbar.
	// When activeTab is null (panel collapsed), show which tab *would* be active.
	const selectedCard = selectedTaskId !== null;
	const visualActiveTab: SidebarTabId = activeTab ?? (selectedCard ? lastTaskTab : "home");

	// --- Auto-switch tabs when selectedTaskId changes ---
	const activeTabRef = useRef(activeTab);
	activeTabRef.current = activeTab;

	useEffect(() => {
		const currentTab = activeTabRef.current;

		if (selectedTaskId) {
			// Task selected from home (board view): open board sidebar so user keeps column context.
			// Task selected from collapsed: stay collapsed (respect user's preference).
			// Task-to-task switch: stay on the current tab.
			if (currentTab === "home") {
				setActiveTab("task_column");
				setLastTaskTab("task_column");
			} else if (currentTab === null) {
				setActiveTab(null);
			}
		} else {
			// Task deselected: switch to home, but only if currently on a task-only tab.
			// Files and Projects tabs work without a task, so stay on them.
			// If activeTab is null (panel collapsed), stay collapsed.
			if (currentTab !== null && currentTab !== "home" && currentTab !== "projects" && currentTab !== "files") {
				setActiveTab("home");
			}
		}
	}, [selectedTaskId, setActiveTab, setLastTaskTab]);

	const setSidePanelRatio = useCallback((ratio: number) => {
		setSidePanelRatioState(persistResizePreference(SIDE_PANEL_RATIO_PREFERENCE, ratio));
	}, []);

	const setDetailDiffFileTreeRatio = useCallback(
		(ratio: number) => {
			if (isDiffExpanded) {
				setExpandedDetailDiffFileTreeRatioState(
					persistResizePreference(EXPANDED_DIFF_FILE_TREE_RATIO_PREFERENCE, ratio),
				);
				return;
			}
			setCollapsedDetailDiffFileTreeRatioState(
				persistResizePreference(COLLAPSED_DIFF_FILE_TREE_RATIO_PREFERENCE, ratio),
			);
		},
		[isDiffExpanded],
	);

	const setDetailFileBrowserTreeRatio = useCallback(
		(ratio: number) => {
			if (isFileBrowserExpanded) {
				setExpandedFileBrowserTreeRatioState(
					persistResizePreference(EXPANDED_FILE_BROWSER_TREE_RATIO_PREFERENCE, ratio),
				);
				return;
			}
			setCollapsedFileBrowserTreeRatioState(
				persistResizePreference(COLLAPSED_FILE_BROWSER_TREE_RATIO_PREFERENCE, ratio),
			);
		},
		[isFileBrowserExpanded],
	);

	const resetToDefaults = useCallback(() => {
		setSidePanelRatioState(getResizePreferenceDefaultValue(SIDE_PANEL_RATIO_PREFERENCE));
		setCollapsedDetailDiffFileTreeRatioState(
			getResizePreferenceDefaultValue(COLLAPSED_DIFF_FILE_TREE_RATIO_PREFERENCE),
		);
		setExpandedDetailDiffFileTreeRatioState(
			getResizePreferenceDefaultValue(EXPANDED_DIFF_FILE_TREE_RATIO_PREFERENCE),
		);
		setCollapsedFileBrowserTreeRatioState(
			getResizePreferenceDefaultValue(COLLAPSED_FILE_BROWSER_TREE_RATIO_PREFERENCE),
		);
		setExpandedFileBrowserTreeRatioState(
			getResizePreferenceDefaultValue(EXPANDED_FILE_BROWSER_TREE_RATIO_PREFERENCE),
		);
	}, []);

	return {
		activeTab,
		setActiveTab,
		lastTaskTab,
		handleTabChange,
		visualActiveTab,
		sidePanelRatio,
		setSidePanelRatio,
		detailDiffFileTreeRatio: isDiffExpanded ? expandedDetailDiffFileTreeRatio : collapsedDetailDiffFileTreeRatio,
		setDetailDiffFileTreeRatio,
		detailFileBrowserTreeRatio: isFileBrowserExpanded ? expandedFileBrowserTreeRatio : collapsedFileBrowserTreeRatio,
		setDetailFileBrowserTreeRatio,
		resetToDefaults,
	};
}
