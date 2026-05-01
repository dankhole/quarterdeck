import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import {
	closeFileEditorTab,
	deleteFileEditorEntryPath,
	FILE_EDITOR_AUTOSAVE_DELAY_MS,
	type FileEditorAutosaveMode,
	type FileEditorTab,
	getCachedFileEditorTabs,
	hasDirtyCachedFileEditorTabs,
	hasDirtyFileEditorEntryPath,
	isFileEditorTabDirty,
	isFileEditorTabEditable,
	markFileEditorTabSaved,
	renameFileEditorEntryPath,
	setCachedFileEditorTabs,
	updateFileEditorTabError,
	updateFileEditorTabSaving,
	updateFileEditorTabValue,
	upsertLoadedFileEditorTab,
} from "@/hooks/git/file-editor-workspace";
import type { RuntimeFileContentResponse, RuntimeWorkdirEntryKind } from "@/runtime/types";
import { useDebouncedEffect, useDocumentEvent, useWindowEvent } from "@/utils/react-use";

export interface UseFileEditorWorkspaceInput {
	scopeKey: string;
	selectedPath: string | null;
	fileContent: RuntimeFileContentResponse | null;
	isContentLoading: boolean;
	isContentError: boolean;
	isReadOnly: boolean;
	autosaveMode: FileEditorAutosaveMode;
	onSelectPath: (path: string | null) => void;
	onCloseFile: () => void;
	reloadFileContent: (path: string) => Promise<RuntimeFileContentResponse | null>;
	saveFileContent: (path: string, content: string, expectedContentHash: string) => Promise<RuntimeFileContentResponse>;
}

export type FileEditorDiscardPrompt =
	| { readonly action: "close" | "reload"; readonly path: string }
	| { readonly action: "close_all"; readonly dirtyCount: number };

export interface UseFileEditorWorkspaceResult {
	readonly tabs: readonly FileEditorTab[];
	readonly activeTab: FileEditorTab | null;
	readonly activePath: string | null;
	readonly canEditActiveTab: boolean;
	readonly isActiveTabDirty: boolean;
	readonly hasDirtyTabs: boolean;
	readonly discardPrompt: FileEditorDiscardPrompt | null;
	handleSelectTab: (path: string) => void;
	handleCloseTab: (path: string) => void;
	handleChangeActiveContent: (value: string) => void;
	handleSaveActiveTab: () => Promise<void>;
	handleSaveAllTabs: () => Promise<void>;
	handleCloseAllTabs: () => void;
	handleAutosaveFocusChange: () => void;
	handleReloadActiveTab: () => Promise<void>;
	handleCancelDiscardPrompt: () => void;
	handleConfirmDiscardPrompt: () => Promise<void>;
	hasDirtyPath: (path: string, kind: RuntimeWorkdirEntryKind) => boolean;
	handleRenameEntryPath: (path: string, nextPath: string, kind: RuntimeWorkdirEntryKind) => void;
	handleDeleteEntryPath: (path: string, kind: RuntimeWorkdirEntryKind) => void;
}

type SaveFileEditorTabResult = "saved" | "skipped" | "failed";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useFileEditorDirtyUnloadGuard(): void {
	const handleBeforeUnload = useCallback((event: BeforeUnloadEvent) => {
		if (!hasDirtyCachedFileEditorTabs()) {
			return;
		}
		event.preventDefault();
		event.returnValue = "";
	}, []);

	useWindowEvent("beforeunload", handleBeforeUnload);
}

export function useFileEditorWorkspace(input: UseFileEditorWorkspaceInput): UseFileEditorWorkspaceResult {
	const {
		scopeKey,
		selectedPath,
		fileContent,
		isContentLoading,
		isContentError,
		isReadOnly,
		autosaveMode,
		onSelectPath,
		onCloseFile,
		reloadFileContent,
		saveFileContent,
	} = input;
	const [tabsState, setTabsState] = useState<{ readonly scopeKey: string; readonly tabs: FileEditorTab[] }>(() => ({
		scopeKey,
		tabs: getCachedFileEditorTabs(scopeKey),
	}));
	const [discardPrompt, setDiscardPrompt] = useState<FileEditorDiscardPrompt | null>(null);
	const savingPathsRef = useRef(new Set<string>());
	const tabs = tabsState.scopeKey === scopeKey ? tabsState.tabs : getCachedFileEditorTabs(scopeKey);

	const isTabSaving = useCallback((tab: FileEditorTab): boolean => {
		return tab.isSaving || savingPathsRef.current.has(tab.path);
	}, []);

	const setScopedTabs = useCallback(
		(updater: (currentTabs: FileEditorTab[]) => FileEditorTab[]) => {
			setTabsState((currentState) => {
				const currentTabs =
					currentState.scopeKey === scopeKey ? currentState.tabs : getCachedFileEditorTabs(scopeKey);
				const nextTabs = updater(currentTabs);
				setCachedFileEditorTabs(scopeKey, nextTabs);
				return { scopeKey, tabs: nextTabs };
			});
		},
		[scopeKey],
	);

	useEffect(() => {
		if (tabsState.scopeKey !== scopeKey) {
			setTabsState({ scopeKey, tabs: getCachedFileEditorTabs(scopeKey) });
			setDiscardPrompt(null);
		}
	}, [scopeKey, tabsState.scopeKey]);

	useEffect(() => {
		if (!selectedPath || !fileContent || isContentLoading || isContentError) {
			return;
		}
		setScopedTabs((currentTabs) => upsertLoadedFileEditorTab(currentTabs, selectedPath, fileContent));
	}, [fileContent, isContentError, isContentLoading, selectedPath, setScopedTabs]);

	const activeTab = useMemo(() => tabs.find((tab) => tab.path === selectedPath) ?? null, [selectedPath, tabs]);
	const isActiveTabDirty = activeTab ? isFileEditorTabDirty(activeTab) : false;
	const canEditActiveTab = activeTab ? isFileEditorTabEditable(activeTab, isReadOnly) : false;
	const dirtyTabs = useMemo(() => tabs.filter(isFileEditorTabDirty), [tabs]);
	const hasDirtyTabs = dirtyTabs.length > 0;

	const closeTab = useCallback(
		(path: string) => {
			const result = closeFileEditorTab(tabs, path, selectedPath);
			setScopedTabs(() => result.tabs);
			if (result.nextActivePath) {
				onSelectPath(result.nextActivePath);
			} else {
				onCloseFile();
			}
		},
		[onCloseFile, onSelectPath, selectedPath, setScopedTabs, tabs],
	);

	const closeAllTabs = useCallback(() => {
		setScopedTabs(() => []);
		onCloseFile();
	}, [onCloseFile, setScopedTabs]);

	const handleCloseTab = useCallback(
		(path: string) => {
			const tab = tabs.find((candidate) => candidate.path === path);
			if (tab && isTabSaving(tab)) {
				showAppToast({
					intent: "warning",
					message: "Wait for the file save to finish before closing it.",
					timeout: 4000,
				});
				return;
			}
			if (tab && isFileEditorTabDirty(tab)) {
				setDiscardPrompt({ action: "close", path });
				return;
			}
			closeTab(path);
		},
		[closeTab, isTabSaving, tabs],
	);

	const handleCloseAllTabs = useCallback(() => {
		if (tabs.some(isTabSaving)) {
			showAppToast({
				intent: "warning",
				message: "Wait for file saves to finish before closing all files.",
				timeout: 4000,
			});
			return;
		}
		if (dirtyTabs.length > 0) {
			setDiscardPrompt({ action: "close_all", dirtyCount: dirtyTabs.length });
			return;
		}
		closeAllTabs();
	}, [closeAllTabs, dirtyTabs.length, isTabSaving, tabs]);

	const handleChangeActiveContent = useCallback(
		(value: string) => {
			if (!selectedPath) return;
			setScopedTabs((currentTabs) => updateFileEditorTabValue(currentTabs, selectedPath, value));
		},
		[selectedPath, setScopedTabs],
	);

	const saveTab = useCallback(
		async (tab: FileEditorTab, options: { notifySuccess: boolean }): Promise<SaveFileEditorTabResult> => {
			if (!isFileEditorTabEditable(tab, isReadOnly) || tab.isSaving || savingPathsRef.current.has(tab.path)) {
				return "skipped";
			}
			if (!isFileEditorTabDirty(tab)) {
				return "skipped";
			}
			const expectedContentHash = tab.contentHash;
			const submittedValue = tab.value;
			if (!expectedContentHash) {
				showAppToast({ intent: "danger", message: "Cannot save without a loaded file revision." });
				return "failed";
			}
			savingPathsRef.current.add(tab.path);
			setScopedTabs((currentTabs) => updateFileEditorTabSaving(currentTabs, tab.path, true));
			try {
				const saved = await saveFileContent(tab.path, submittedValue, expectedContentHash);
				setScopedTabs((currentTabs) => markFileEditorTabSaved(currentTabs, tab.path, saved, submittedValue));
				if (options.notifySuccess) {
					showAppToast({ intent: "success", message: "File saved.", timeout: 2500 });
				}
				return "saved";
			} catch (error) {
				const message = toErrorMessage(error);
				setScopedTabs((currentTabs) => updateFileEditorTabError(currentTabs, tab.path, message));
				showAppToast({ intent: "danger", message, timeout: 7000 });
				return "failed";
			} finally {
				savingPathsRef.current.delete(tab.path);
			}
		},
		[isReadOnly, saveFileContent, setScopedTabs],
	);

	const handleSaveActiveTab = useCallback(async () => {
		if (!activeTab) {
			return;
		}
		await saveTab(activeTab, { notifySuccess: true });
	}, [activeTab, saveTab]);

	const handleSaveAllTabs = useCallback(async () => {
		let savedCount = 0;
		let skippedDirtyCount = 0;
		let failedCount = 0;

		for (const tab of dirtyTabs) {
			const result = await saveTab(tab, { notifySuccess: false });
			if (result === "saved") {
				savedCount++;
			} else if (result === "failed") {
				failedCount++;
			} else if (isFileEditorTabDirty(tab)) {
				skippedDirtyCount++;
			}
		}

		if (savedCount > 0 && failedCount === 0 && skippedDirtyCount === 0) {
			showAppToast({
				intent: "success",
				message: `${savedCount} file${savedCount === 1 ? "" : "s"} saved.`,
				timeout: 2500,
			});
		} else if (skippedDirtyCount > 0) {
			showAppToast({
				intent: "warning",
				message: `${skippedDirtyCount} dirty file${skippedDirtyCount === 1 ? "" : "s"} could not be saved.`,
				timeout: 5000,
			});
		}
	}, [dirtyTabs, saveTab]);

	const handleAutosaveFocusChange = useCallback(() => {
		if (autosaveMode !== "focus" || !activeTab || discardPrompt !== null) {
			return;
		}
		void saveTab(activeTab, { notifySuccess: false });
	}, [activeTab, autosaveMode, discardPrompt, saveTab]);

	const handleDocumentVisibilityChange = useCallback(() => {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") {
			handleAutosaveFocusChange();
		}
	}, [handleAutosaveFocusChange]);

	const handleSelectTab = useCallback(
		(path: string) => {
			if (path !== selectedPath) {
				handleAutosaveFocusChange();
			}
			onSelectPath(path);
		},
		[handleAutosaveFocusChange, onSelectPath, selectedPath],
	);

	useDebouncedEffect(
		() => {
			if (autosaveMode !== "delay" || dirtyTabs.length === 0 || discardPrompt !== null) {
				return;
			}
			void (async () => {
				for (const tab of dirtyTabs) {
					await saveTab(tab, { notifySuccess: false });
				}
			})();
		},
		FILE_EDITOR_AUTOSAVE_DELAY_MS,
		[autosaveMode, dirtyTabs, discardPrompt, saveTab],
	);

	useWindowEvent("blur", autosaveMode === "focus" ? handleAutosaveFocusChange : null);
	useDocumentEvent("visibilitychange", autosaveMode === "focus" ? handleDocumentVisibilityChange : null);

	const reloadTab = useCallback(
		async (path: string) => {
			try {
				const reloaded = await reloadFileContent(path);
				if (!reloaded) {
					throw new Error("Failed to reload file.");
				}
				setScopedTabs((currentTabs) => upsertLoadedFileEditorTab(currentTabs, path, reloaded, { force: true }));
				showAppToast({ intent: "success", message: "File reloaded.", timeout: 2500 });
			} catch (error) {
				const message = toErrorMessage(error);
				setScopedTabs((currentTabs) => updateFileEditorTabError(currentTabs, path, message));
				showAppToast({ intent: "danger", message, timeout: 7000 });
			}
		},
		[reloadFileContent, setScopedTabs],
	);

	const handleReloadActiveTab = useCallback(async () => {
		if (!activeTab) {
			return;
		}
		if (isTabSaving(activeTab)) {
			showAppToast({
				intent: "warning",
				message: "Wait for the file save to finish before reloading it.",
				timeout: 4000,
			});
			return;
		}
		if (isFileEditorTabDirty(activeTab)) {
			setDiscardPrompt({ action: "reload", path: activeTab.path });
			return;
		}
		await reloadTab(activeTab.path);
	}, [activeTab, isTabSaving, reloadTab]);

	const handleCancelDiscardPrompt = useCallback(() => {
		setDiscardPrompt(null);
	}, []);

	const handleConfirmDiscardPrompt = useCallback(async () => {
		const prompt = discardPrompt;
		if (!prompt) return;
		setDiscardPrompt(null);
		if (prompt.action === "close_all") {
			closeAllTabs();
			return;
		}
		if (prompt.action === "close") {
			closeTab(prompt.path);
			return;
		}
		await reloadTab(prompt.path);
	}, [closeAllTabs, closeTab, discardPrompt, reloadTab]);

	const hasDirtyPath = useCallback(
		(path: string, kind: RuntimeWorkdirEntryKind) => hasDirtyFileEditorEntryPath(tabs, path, kind),
		[tabs],
	);

	const handleRenameEntryPath = useCallback(
		(path: string, nextPath: string, kind: RuntimeWorkdirEntryKind) => {
			setScopedTabs((currentTabs) => renameFileEditorEntryPath(currentTabs, path, nextPath, kind));
		},
		[setScopedTabs],
	);

	const handleDeleteEntryPath = useCallback(
		(path: string, kind: RuntimeWorkdirEntryKind) => {
			setScopedTabs((currentTabs) => deleteFileEditorEntryPath(currentTabs, path, kind));
		},
		[setScopedTabs],
	);

	return {
		tabs,
		activeTab,
		activePath: selectedPath,
		canEditActiveTab,
		isActiveTabDirty,
		hasDirtyTabs,
		discardPrompt,
		handleSelectTab,
		handleCloseTab,
		handleChangeActiveContent,
		handleSaveActiveTab,
		handleSaveAllTabs,
		handleCloseAllTabs,
		handleAutosaveFocusChange,
		handleReloadActiveTab,
		handleCancelDiscardPrompt,
		handleConfirmDiscardPrompt,
		hasDirtyPath,
		handleRenameEntryPath,
		handleDeleteEntryPath,
	};
}
