import type { RuntimeFileContentResponse, RuntimeWorkdirEntryKind } from "@/runtime/types";

export const FILE_EDITOR_AUTOSAVE_DELAY_MS = 1500;
export const FILE_EDITOR_AUTOSAVE_MODES = ["off", "delay", "focus"] as const;

export type FileEditorAutosaveMode = (typeof FILE_EDITOR_AUTOSAVE_MODES)[number];

export interface FileEditorTab {
	path: string;
	value: string;
	savedValue: string;
	contentHash: string | null;
	language: string;
	binary: boolean;
	truncated: boolean;
	editable: boolean;
	editBlockedReason: string | null;
	size: number;
	isSaving: boolean;
	error: string | null;
}

export function normalizeFileEditorAutosaveMode(value: string | null | undefined): FileEditorAutosaveMode {
	return FILE_EDITOR_AUTOSAVE_MODES.includes(value as FileEditorAutosaveMode)
		? (value as FileEditorAutosaveMode)
		: "off";
}

export function isFileEditorTabDirty(tab: FileEditorTab): boolean {
	return tab.value !== tab.savedValue;
}

const cachedTabsByScope = new Map<string, FileEditorTab[]>();

export function getCachedFileEditorTabs(scopeKey: string): FileEditorTab[] {
	return cachedTabsByScope.get(scopeKey) ?? [];
}

export function setCachedFileEditorTabs(scopeKey: string, tabs: readonly FileEditorTab[]): void {
	if (tabs.length > 0) {
		cachedTabsByScope.set(scopeKey, [...tabs]);
	} else {
		cachedTabsByScope.delete(scopeKey);
	}
}

export function clearCachedFileEditorTabs(scopeKey?: string): void {
	if (scopeKey) {
		cachedTabsByScope.delete(scopeKey);
		return;
	}
	cachedTabsByScope.clear();
}

export function hasDirtyCachedFileEditorTabs(): boolean {
	for (const tabs of cachedTabsByScope.values()) {
		if (tabs.some(isFileEditorTabDirty)) {
			return true;
		}
	}
	return false;
}

export function isFileEditorTabEditable(tab: FileEditorTab, readOnly: boolean): boolean {
	return !readOnly && tab.editable && !tab.binary && !tab.truncated && tab.contentHash !== null;
}

export function createFileEditorTab(path: string, content: RuntimeFileContentResponse): FileEditorTab {
	const editable = content.editable ?? (!content.binary && !content.truncated && content.contentHash !== undefined);
	return {
		path,
		value: content.content,
		savedValue: content.content,
		contentHash: content.contentHash ?? null,
		language: content.language,
		binary: content.binary,
		truncated: content.truncated,
		editable,
		editBlockedReason: content.editBlockedReason ?? null,
		size: content.size,
		isSaving: false,
		error: null,
	};
}

export function upsertLoadedFileEditorTab(
	tabs: readonly FileEditorTab[],
	path: string,
	content: RuntimeFileContentResponse,
	options: { force?: boolean } = {},
): FileEditorTab[] {
	const index = tabs.findIndex((tab) => tab.path === path);
	if (index < 0) {
		return [...tabs, createFileEditorTab(path, content)];
	}
	const existing = tabs[index]!;
	if (!options.force && isFileEditorTabDirty(existing)) {
		return tabs.map((tab) =>
			tab.path === path
				? {
						...tab,
						language: content.language,
						binary: content.binary,
						truncated: content.truncated,
						editable:
							content.editable ?? (!content.binary && !content.truncated && content.contentHash !== undefined),
						editBlockedReason: content.editBlockedReason ?? null,
						size: content.size,
					}
				: tab,
		);
	}
	const nextTab = createFileEditorTab(path, content);
	return tabs.map((tab) => (tab.path === path ? nextTab : tab));
}

export function updateFileEditorTabValue(tabs: readonly FileEditorTab[], path: string, value: string): FileEditorTab[] {
	return tabs.map((tab) => (tab.path === path ? { ...tab, value, error: null } : tab));
}

export function updateFileEditorTabSaving(
	tabs: readonly FileEditorTab[],
	path: string,
	isSaving: boolean,
): FileEditorTab[] {
	return tabs.map((tab) => (tab.path === path ? { ...tab, isSaving } : tab));
}

export function updateFileEditorTabError(
	tabs: readonly FileEditorTab[],
	path: string,
	error: string | null,
): FileEditorTab[] {
	return tabs.map((tab) => (tab.path === path ? { ...tab, error, isSaving: false } : tab));
}

function applySavedContentToFileEditorTab(
	tab: FileEditorTab,
	content: RuntimeFileContentResponse,
	submittedValue: string,
): FileEditorTab {
	const savedValue = content.content;
	const value = tab.value === submittedValue ? savedValue : tab.value;
	return {
		...tab,
		value,
		savedValue,
		contentHash: content.contentHash ?? null,
		language: content.language,
		binary: content.binary,
		truncated: content.truncated,
		editable: content.editable ?? (!content.binary && !content.truncated && content.contentHash !== undefined),
		editBlockedReason: content.editBlockedReason ?? null,
		size: content.size,
		isSaving: false,
		error: null,
	};
}

export function markFileEditorTabSaved(
	tabs: readonly FileEditorTab[],
	path: string,
	content: RuntimeFileContentResponse,
	submittedValue: string,
): FileEditorTab[] {
	return tabs.map((tab) => (tab.path === path ? applySavedContentToFileEditorTab(tab, content, submittedValue) : tab));
}

export function closeFileEditorTab(
	tabs: readonly FileEditorTab[],
	path: string,
	activePath: string | null,
): { tabs: FileEditorTab[]; nextActivePath: string | null } {
	const index = tabs.findIndex((tab) => tab.path === path);
	if (index < 0) {
		return { tabs: [...tabs], nextActivePath: activePath };
	}
	const nextTabs = tabs.filter((tab) => tab.path !== path);
	if (activePath !== path) {
		return { tabs: nextTabs, nextActivePath: activePath };
	}
	return {
		tabs: nextTabs,
		nextActivePath: nextTabs[Math.min(index, nextTabs.length - 1)]?.path ?? null,
	};
}

export function pathMatchesFileEditorEntry(path: string, entryPath: string, kind: RuntimeWorkdirEntryKind): boolean {
	return path === entryPath || (kind === "directory" && path.startsWith(`${entryPath}/`));
}

export function hasDirtyFileEditorEntryPath(
	tabs: readonly FileEditorTab[],
	path: string,
	kind: RuntimeWorkdirEntryKind,
): boolean {
	return tabs.some((tab) => pathMatchesFileEditorEntry(tab.path, path, kind) && isFileEditorTabDirty(tab));
}

export function renameFileEditorEntryPath(
	tabs: readonly FileEditorTab[],
	path: string,
	nextPath: string,
	kind: RuntimeWorkdirEntryKind,
): FileEditorTab[] {
	return tabs.map((tab) =>
		pathMatchesFileEditorEntry(tab.path, path, kind)
			? {
					...tab,
					path: tab.path === path ? nextPath : `${nextPath}/${tab.path.slice(path.length + 1)}`,
				}
			: tab,
	);
}

export function deleteFileEditorEntryPath(
	tabs: readonly FileEditorTab[],
	path: string,
	kind: RuntimeWorkdirEntryKind,
): FileEditorTab[] {
	return tabs.filter((tab) => !pathMatchesFileEditorEntry(tab.path, path, kind));
}
