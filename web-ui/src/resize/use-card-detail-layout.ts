import { useCallback, useState } from "react";

import { useLayoutResetEffect } from "@/resize/layout-customizations";
import { clampBetween } from "@/resize/resize-persistence";
import {
	getResizePreferenceDefaultValue,
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

export type DetailPanelId = "quarterdeck" | "changes" | "files";

const SIDE_PANEL_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailSidePanelRatio,
	defaultValue: 0.25,
	normalize: (value) => clampBetween(value, 0.14, 0.45),
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

function loadActivePanel(): DetailPanelId | null {
	const stored = readLocalStorageItem(LocalStorageKey.DetailActivePanel);
	if (stored === "quarterdeck" || stored === "changes" || stored === "files") {
		return stored;
	}
	if (stored === "") {
		return null;
	}
	return "quarterdeck";
}

function persistActivePanel(panel: DetailPanelId | null): DetailPanelId | null {
	writeLocalStorageItem(LocalStorageKey.DetailActivePanel, panel ?? "");
	return panel;
}

export function useCardDetailLayout({
	isDiffExpanded,
	isFileBrowserExpanded,
}: {
	isDiffExpanded: boolean;
	isFileBrowserExpanded: boolean;
}): {
	activeDetailPanel: DetailPanelId | null;
	setActiveDetailPanel: (panel: DetailPanelId | null) => void;
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
	detailDiffFileTreeRatio: number;
	setDetailDiffFileTreeRatio: (ratio: number) => void;
	detailFileBrowserTreeRatio: number;
	setDetailFileBrowserTreeRatio: (ratio: number) => void;
} {
	const [activeDetailPanel, setActiveDetailPanelState] = useState<DetailPanelId | null>(loadActivePanel);
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

	const setActiveDetailPanel = useCallback((panel: DetailPanelId | null) => {
		setActiveDetailPanelState(persistActivePanel(panel));
	}, []);

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

	useLayoutResetEffect(() => {
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
	});

	return {
		activeDetailPanel,
		setActiveDetailPanel,
		sidePanelRatio,
		setSidePanelRatio,
		detailDiffFileTreeRatio: isDiffExpanded ? expandedDetailDiffFileTreeRatio : collapsedDetailDiffFileTreeRatio,
		setDetailDiffFileTreeRatio,
		detailFileBrowserTreeRatio: isFileBrowserExpanded ? expandedFileBrowserTreeRatio : collapsedFileBrowserTreeRatio,
		setDetailFileBrowserTreeRatio,
	};
}
