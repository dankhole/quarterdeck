import { useCallback, useEffect, useRef, useState } from "react";

import { clampBetween } from "@/resize/resize-persistence";
import {
	getResizePreferenceDefaultValue,
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

// --- New dual-selection types ---

export type MainViewId = "home" | "terminal" | "files" | "git";
export type SidebarId = "projects" | "task_column";

const SIDE_PANEL_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailSidePanelRatio,
	defaultValue: 0.15,
	normalize: (value) => clampBetween(value, 0.14, 0.8),
};

// --- localStorage loaders / persisters (migration-aware) ---

/**
 * Load mainView from localStorage with migration from old single-tab model.
 * Old `DetailActivePanel` values map to: home→home, projects→home, task_column→terminal,
 * changes→terminal, files→files, ""→home.
 */
export function loadMainView(): MainViewId {
	const stored = readLocalStorageItem(LocalStorageKey.DetailMainView);
	if (stored === "home" || stored === "terminal" || stored === "files" || stored === "git") return stored;
	if (stored === "changes") return "git"; // Old sidebar value → new main view

	// Migration: read old key
	const legacy = readLocalStorageItem(LocalStorageKey.DetailActivePanel);
	if (legacy === "task_column" || legacy === "changes") return "terminal";
	if (legacy === "files") return "files";
	return "home"; // default for new installs and all other legacy values
}

function persistMainView(view: MainViewId): MainViewId {
	writeLocalStorageItem(LocalStorageKey.DetailMainView, view);
	return view;
}

/**
 * Load sidebar from localStorage with migration from old single-tab model.
 * Old `DetailActivePanel` values map to: home→projects, projects→projects,
 * task_column→task_column, changes→changes, files→projects, ""→null.
 */
export function loadSidebar(): SidebarId | null {
	const stored = readLocalStorageItem(LocalStorageKey.DetailSidebar);
	if (stored === "projects" || stored === "task_column") return stored;
	if (stored === "changes") return "task_column"; // Old "changes" sidebar → task_column
	if (stored === "") return null; // sidebar was collapsed

	// Migration: read old key
	const legacy = readLocalStorageItem(LocalStorageKey.DetailActivePanel);
	if (legacy === "task_column") return "task_column";
	if (legacy === "changes") return "task_column";
	if (legacy === "") return null;
	return "projects"; // default for new installs and all other legacy values
}

function persistSidebar(sidebar: SidebarId | null): SidebarId | null {
	writeLocalStorageItem(LocalStorageKey.DetailSidebar, sidebar ?? "");
	return sidebar;
}

export function loadLastSidebarTab(): SidebarId {
	const stored = readLocalStorageItem(LocalStorageKey.DetailLastSidebarTab);
	if (stored === "projects" || stored === "task_column") return stored;
	if (stored === "changes") return "task_column";

	// Migration: read old key
	const legacy = readLocalStorageItem(LocalStorageKey.DetailLastTaskTab);
	if (legacy === "task_column") return legacy;
	if (legacy === "changes") return "task_column";
	return "task_column"; // default
}

function persistLastSidebarTab(tab: SidebarId): SidebarId {
	writeLocalStorageItem(LocalStorageKey.DetailLastSidebarTab, tab);
	return tab;
}

export function useCardDetailLayout({ selectedTaskId }: { selectedTaskId: string | null }): {
	mainView: MainViewId;
	sidebar: SidebarId | null;
	setMainView: (view: MainViewId, callbacks?: { setSelectedTaskId?: (id: string | null) => void }) => void;
	toggleSidebar: (id: SidebarId) => void;
	sidebarPinned: boolean;
	toggleSidebarPinned: () => void;
	visualMainView: MainViewId;
	visualSidebar: SidebarId | null;
	lastSidebarTab: SidebarId;
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
	resetToDefaults: () => void;
} {
	// Always start on home+projects — view state is transient, not worth restoring across tab reopens.
	// localStorage is still written (for within-session auto-coupling) but not read on mount.
	const [mainView, setMainViewState] = useState<MainViewId>("home");
	const [sidebar, setSidebarState] = useState<SidebarId | null>("projects");
	const [lastSidebarTab, setLastSidebarTabState] = useState<SidebarId>(loadLastSidebarTab);
	const [sidePanelRatio, setSidePanelRatioState] = useState(() => loadResizePreference(SIDE_PANEL_RATIO_PREFERENCE));

	const setMainViewPersist = useCallback((view: MainViewId) => {
		setMainViewState(persistMainView(view));
	}, []);

	const setSidebarPersist = useCallback((s: SidebarId | null) => {
		setSidebarState(persistSidebar(s));
	}, []);

	const setLastSidebarTab = useCallback((tab: SidebarId) => {
		setLastSidebarTabState(persistLastSidebarTab(tab));
	}, []);

	const [sidebarPinned, setSidebarPinned] = useState(
		() => readLocalStorageItem(LocalStorageKey.SidebarPinned) === "true",
	);
	const toggleSidebarPinned = useCallback(() => {
		setSidebarPinned((prev) => {
			const next = !prev;
			writeLocalStorageItem(LocalStorageKey.SidebarPinned, String(next));
			return next;
		});
	}, []);
	const sidebarPinnedRef = useRef(sidebarPinned);
	sidebarPinnedRef.current = sidebarPinned;

	/**
	 * Set the main view. Auto-coupling rules:
	 * - "home" → also sets sidebar to "projects" and deselects the task.
	 * - "terminal" / "files" → no side effects on sidebar or task selection.
	 */
	const setMainView = useCallback(
		(view: MainViewId, callbacks?: { setSelectedTaskId?: (id: string | null) => void }) => {
			setMainViewPersist(view);
			if (view === "home") {
				setSidebarPersist("projects");
				callbacks?.setSelectedTaskId?.(null);
			}
		},
		[setMainViewPersist, setSidebarPersist],
	);

	/**
	 * Toggle sidebar. Clicking the active sidebar tab collapses it (null).
	 * Clicking a different tab switches to it and persists as lastSidebarTab
	 * for task-tied tabs.
	 */
	const toggleSidebar = useCallback(
		(id: SidebarId) => {
			if (id === sidebar) {
				setSidebarPersist(null);
				return;
			}
			setSidebarPersist(id);
			if (id === "task_column") {
				setLastSidebarTab(id);
			}
		},
		[sidebar, setSidebarPersist, setLastSidebarTab],
	);

	// Derive visual highlight indicators for the toolbar.
	const selectedCard = selectedTaskId !== null;
	const visualMainView: MainViewId = mainView;
	// When mainView is "git", the integrated tree replaces the sidebar panel — no sidebar icon is active.
	// When sidebar is collapsed, show which tab *would* reopen (accent highlight).
	const visualSidebar: SidebarId | null =
		mainView === "git" ? null : (sidebar ?? (selectedCard ? lastSidebarTab : "projects"));

	// --- Auto-switch when selectedTaskId changes (not on initial mount) ---
	const mainViewRef = useRef(mainView);
	mainViewRef.current = mainView;
	const sidebarRef = useRef(sidebar);
	sidebarRef.current = sidebar;
	const isInitialMountRef = useRef(true);
	useEffect(() => {
		if (isInitialMountRef.current) {
			isInitialMountRef.current = false;
			return;
		}
		const currentMainView = mainViewRef.current;
		const pinned = sidebarPinnedRef.current;

		if (selectedTaskId) {
			// Task selected: switch to terminal + task_column from home.
			// From terminal, files, or git view: keep current state (all work with task context).
			if (currentMainView === "home") {
				setMainViewPersist("terminal");
				if (!pinned) {
					setSidebarPersist("task_column");
					setLastSidebarTab("task_column");
				}
			}
			// else: already on terminal/files/git — leave mainView and sidebar as-is
		} else {
			// Task deselected: terminal needs a task, others work without one.
			if (currentMainView === "terminal") {
				setMainViewPersist("home");
				// task_column can't function without a task, so always fall back to projects.
				// For other sidebars (projects), respect the pin.
				if (!pinned || sidebarRef.current === "task_column") {
					setSidebarPersist("projects");
				}
			}
			// else: "home", "files", "git" all work without a task — stay put
		}
	}, [selectedTaskId, setMainViewPersist, setSidebarPersist, setLastSidebarTab]);

	const setSidePanelRatio = useCallback((ratio: number) => {
		setSidePanelRatioState(persistResizePreference(SIDE_PANEL_RATIO_PREFERENCE, ratio));
	}, []);

	const resetToDefaults = useCallback(() => {
		setSidePanelRatioState(getResizePreferenceDefaultValue(SIDE_PANEL_RATIO_PREFERENCE));
	}, []);

	return {
		mainView,
		sidebar,
		setMainView,
		toggleSidebar,
		sidebarPinned,
		toggleSidebarPinned,
		visualMainView,
		visualSidebar,
		lastSidebarTab,
		sidePanelRatio,
		setSidePanelRatio,
		resetToDefaults,
	};
}
