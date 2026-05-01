import { FolderOpen, PanelLeft } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FileBrowserTreePanel } from "@/components/git/panels/file-browser-tree-panel";
import { FileEditorPanel } from "@/components/git/panels/file-editor-panel";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { useFileEditorWorkspace } from "@/hooks/git";
import type { FileEditorAutosaveMode } from "@/hooks/git/file-editor-workspace";
import type { UseFileBrowserDataResult } from "@/hooks/git/use-file-browser-data";
import { ResizeHandle } from "@/resize/resize-handle";
import { clampBetween } from "@/resize/resize-persistence";
import {
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type { RuntimeWorkdirEntryKind, RuntimeWorkdirEntryMutationResponse } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

// --- Constants ---

const FILES_VIEW_FILE_TREE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailFileBrowserTreePanelRatio,
	defaultValue: 0.22,
	normalize: (value) => clampBetween(value, 0.12, 0.5),
};

// --- Component ---

/** Module-level cache of expanded directory sets per scope key. */
const expandedDirsByScope = new Map<string, Set<string>>();
/** Track which scopes have already run their initial expansion. */
const initializedExpansionByScope = new Set<string>();

export interface FilesViewProps {
	/** Pre-built ScopeBar element — parents construct this with their own scope/branch context. */
	scopeBar: ReactNode;
	showScopeBar?: boolean;
	/** File browser data from useFileBrowserData — file list, selection, content. */
	fileBrowserData: UseFileBrowserDataResult;
	fileEditorAutosaveMode: FileEditorAutosaveMode;
	/** Absolute path to the worktree/project root, used for "Copy path" context menu action. */
	rootPath?: string | null;
	/** External file navigation from commit panel — selects a file when arriving from another view. */
	pendingFileNavigation?: { targetView: "git" | "files"; filePath: string; lineNumber?: number } | null;
	/** Called after consuming pendingFileNavigation. */
	onFileNavigationConsumed?: () => void;
	/** Scope key for persisting expanded dirs and scroll position across unmount/remount cycles. */
	scopeKey?: string;
}

export function FilesView({
	scopeBar,
	showScopeBar = true,
	fileBrowserData,
	fileEditorAutosaveMode,
	rootPath,
	pendingFileNavigation,
	onFileNavigationConsumed,
	scopeKey,
}: FilesViewProps): React.ReactElement {
	const [fileTreeVisible, setFileTreeVisible] = useState(true);
	const [fileTreeRatio, setFileTreeRatioState] = useState(() =>
		loadResizePreference(FILES_VIEW_FILE_TREE_RATIO_PREFERENCE),
	);
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
		() => (scopeKey ? expandedDirsByScope.get(scopeKey) : undefined) ?? new Set(),
	);
	const [hasInitializedExpansion, setHasInitializedExpansion] = useState(() =>
		scopeKey ? initializedExpansionByScope.has(scopeKey) : false,
	);

	const [pendingScrollLine, setPendingScrollLine] = useState<number | null>(null);
	const contentRowRef = useRef<HTMLDivElement | null>(null);
	const contentScopeKeyRef = useRef(fileBrowserData.contentScopeKey);
	contentScopeKeyRef.current = fileBrowserData.contentScopeKey;
	const { startDrag: startFileTreeResize } = useResizeDrag();
	const editorWorkspace = useFileEditorWorkspace({
		scopeKey: fileBrowserData.contentScopeKey,
		selectedPath: fileBrowserData.selectedPath,
		fileContent: fileBrowserData.fileContent,
		isContentLoading: fileBrowserData.isContentLoading,
		isContentError: fileBrowserData.isContentError,
		isReadOnly: fileBrowserData.isReadOnly,
		autosaveMode: fileEditorAutosaveMode,
		onSelectPath: fileBrowserData.onSelectPath,
		onCloseFile: fileBrowserData.onCloseFile,
		reloadFileContent: fileBrowserData.reloadFileContent,
		saveFileContent: fileBrowserData.saveFileContent,
	});

	// Persist expanded dirs to module-level cache whenever they change.
	useEffect(() => {
		if (scopeKey) {
			expandedDirsByScope.set(scopeKey, expandedDirs);
		}
	}, [scopeKey, expandedDirs]);

	const handleInitializedExpansion = useCallback(() => {
		setHasInitializedExpansion(true);
		if (scopeKey) {
			initializedExpansionByScope.add(scopeKey);
		}
	}, [scopeKey]);

	// Navigate to a specific file when external file navigation arrives (from commit panel or search)
	useEffect(() => {
		if (pendingFileNavigation?.targetView === "files") {
			fileBrowserData.onSelectPath(pendingFileNavigation.filePath);
			setPendingScrollLine(pendingFileNavigation.lineNumber ?? null);
			onFileNavigationConsumed?.();
		}
	}, [pendingFileNavigation, onFileNavigationConsumed, fileBrowserData]);

	// --- Resize ---

	const setFileTreeRatio = useCallback((ratio: number) => {
		setFileTreeRatioState(persistResizePreference(FILES_VIEW_FILE_TREE_RATIO_PREFERENCE, ratio));
	}, []);

	const handleFileTreeSeparatorMouseDown = useMemo(() => {
		return (event: ReactMouseEvent<HTMLDivElement>) => {
			const container = contentRowRef.current;
			if (!container) return;
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const currentRatio = fileTreeRatio;
			startFileTreeResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => setFileTreeRatio(currentRatio + (pointerX - startX) / containerWidth),
				onEnd: (pointerX) => setFileTreeRatio(currentRatio + (pointerX - startX) / containerWidth),
			});
		};
	}, [fileTreeRatio, setFileTreeRatio, startFileTreeResize]);

	const fileTreePercent = `${(fileTreeRatio * 100).toFixed(1)}%`;
	const contentPercent = `${((1 - fileTreeRatio) * 100).toFixed(1)}%`;

	const expandDirectoryPath = useCallback(
		(path: string) => {
			if (!path) return;
			setExpandedDirs((current) => {
				const next = new Set(current);
				next.add(path);
				return next;
			});
		},
		[setExpandedDirs],
	);

	const handleCreateEntry = useCallback(
		async (path: string, kind: RuntimeWorkdirEntryKind): Promise<RuntimeWorkdirEntryMutationResponse> => {
			const requestScopeKey = fileBrowserData.contentScopeKey;
			const result = await fileBrowserData.createEntry(path, kind);
			if (requestScopeKey !== contentScopeKeyRef.current) {
				return result;
			}
			const parentPath = result.path.includes("/") ? result.path.slice(0, result.path.lastIndexOf("/")) : "";
			expandDirectoryPath(parentPath);
			if (kind === "directory") {
				expandDirectoryPath(result.path);
			}
			return result;
		},
		[expandDirectoryPath, fileBrowserData],
	);

	const handleRenameEntry = useCallback(
		async (
			path: string,
			nextPath: string,
			kind: RuntimeWorkdirEntryKind,
		): Promise<RuntimeWorkdirEntryMutationResponse> => {
			if (editorWorkspace.hasDirtyPath(path, kind)) {
				throw new Error("Save or close unsaved files before renaming.");
			}
			const requestScopeKey = fileBrowserData.contentScopeKey;
			const result = await fileBrowserData.renameEntry(path, nextPath, kind);
			if (requestScopeKey !== contentScopeKeyRef.current) {
				return result;
			}
			editorWorkspace.handleRenameEntryPath(path, result.path, kind);
			if (kind === "directory") {
				setExpandedDirs((current) => {
					const next = new Set<string>();
					for (const expandedPath of current) {
						if (expandedPath === path) {
							next.add(result.path);
						} else if (expandedPath.startsWith(`${path}/`)) {
							next.add(`${result.path}/${expandedPath.slice(path.length + 1)}`);
						} else {
							next.add(expandedPath);
						}
					}
					return next;
				});
			}
			const parentPath = result.path.includes("/") ? result.path.slice(0, result.path.lastIndexOf("/")) : "";
			expandDirectoryPath(parentPath);
			return result;
		},
		[editorWorkspace, expandDirectoryPath, fileBrowserData],
	);

	const handleDeleteEntry = useCallback(
		async (path: string, kind: RuntimeWorkdirEntryKind): Promise<RuntimeWorkdirEntryMutationResponse> => {
			if (editorWorkspace.hasDirtyPath(path, kind)) {
				throw new Error("Save or close unsaved files before deleting.");
			}
			const requestScopeKey = fileBrowserData.contentScopeKey;
			const result = await fileBrowserData.deleteEntry(path, kind);
			if (requestScopeKey !== contentScopeKeyRef.current) {
				return result;
			}
			editorWorkspace.handleDeleteEntryPath(path, kind);
			if (kind === "directory") {
				setExpandedDirs((current) => {
					const next = new Set(current);
					for (const expandedPath of current) {
						if (expandedPath === path || expandedPath.startsWith(`${path}/`)) {
							next.delete(expandedPath);
						}
					}
					return next;
				});
			}
			return result;
		},
		[editorWorkspace, fileBrowserData],
	);

	// --- Render ---

	const hasEntries = (fileBrowserData.files?.length ?? 0) > 0 || (fileBrowserData.directories?.length ?? 0) > 0;
	const canMutateEntries = fileBrowserData.canMutateEntries;

	return (
		<div className="flex flex-col flex-1 min-h-0 min-w-0">
			{/* Scope bar slot */}
			{showScopeBar ? scopeBar : null}

			{/* Toolbar with file tree toggle */}
			<div className="flex items-center gap-1 px-3 h-8 border-b border-border bg-surface-1 shrink-0">
				<div className="flex-1" />
				<Tooltip content={fileTreeVisible ? "Hide file tree" : "Show file tree"}>
					<button
						type="button"
						onClick={() => setFileTreeVisible((v) => !v)}
						className={cn(
							"flex items-center justify-center w-6 h-6 rounded-md border-0 cursor-pointer",
							fileTreeVisible
								? "bg-surface-3 text-text-primary"
								: "bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2",
						)}
					>
						<PanelLeft size={14} />
					</button>
				</Tooltip>
			</div>

			{/* Content area: file tree + file viewer */}
			<div ref={contentRowRef} className="flex flex-1 min-h-0">
				{!hasEntries && !fileBrowserData.selectedPath && !canMutateEntries ? (
					<div className="flex flex-1 items-center justify-center">
						<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
							<FolderOpen size={40} />
							<span className="text-sm">No files</span>
						</div>
					</div>
				) : (
					<>
						{fileTreeVisible && (
							<>
								<div
									style={{
										display: "flex",
										flex: `0 0 ${fileTreePercent}`,
										minWidth: 0,
										minHeight: 0,
									}}
								>
									<FileBrowserTreePanel
										files={fileBrowserData.files}
										directories={fileBrowserData.directories}
										selectedPath={fileBrowserData.selectedPath}
										onSelectPath={fileBrowserData.onSelectPath}
										panelFlex="1 1 0"
										expandedDirs={expandedDirs}
										onExpandedDirsChange={setExpandedDirs}
										hasInitializedExpansion={hasInitializedExpansion}
										onInitializedExpansion={handleInitializedExpansion}
										rootPath={rootPath}
										getFileContent={fileBrowserData.getFileContent}
										onCreateEntry={canMutateEntries ? handleCreateEntry : undefined}
										onRenameEntry={canMutateEntries ? handleRenameEntry : undefined}
										onDeleteEntry={canMutateEntries ? handleDeleteEntry : undefined}
										scopeKey={scopeKey}
									/>
								</div>
								<ResizeHandle
									orientation="vertical"
									ariaLabel="Resize file browser tree"
									onMouseDown={handleFileTreeSeparatorMouseDown}
									className="z-10"
								/>
							</>
						)}
						<div
							style={{
								display: "flex",
								flex: fileTreeVisible ? `0 0 ${contentPercent}` : "1 1 0",
								minWidth: 0,
								minHeight: 0,
							}}
						>
							<FileEditorPanel
								tabs={editorWorkspace.tabs}
								activeTab={editorWorkspace.activeTab}
								activePath={editorWorkspace.activePath}
								isLoading={fileBrowserData.isContentLoading}
								isError={fileBrowserData.isContentError}
								isReadOnly={fileBrowserData.isReadOnly}
								canEditActiveTab={editorWorkspace.canEditActiveTab}
								isActiveTabDirty={editorWorkspace.isActiveTabDirty}
								hasDirtyTabs={editorWorkspace.hasDirtyTabs}
								discardPrompt={editorWorkspace.discardPrompt}
								autosaveMode={fileEditorAutosaveMode}
								scrollToLine={pendingScrollLine}
								onScrollToLineConsumed={() => setPendingScrollLine(null)}
								onSelectTab={editorWorkspace.handleSelectTab}
								onCloseTab={editorWorkspace.handleCloseTab}
								onChangeActiveContent={editorWorkspace.handleChangeActiveContent}
								onSaveActiveTab={editorWorkspace.handleSaveActiveTab}
								onSaveAllTabs={editorWorkspace.handleSaveAllTabs}
								onCloseAllTabs={editorWorkspace.handleCloseAllTabs}
								onAutosaveFocusChange={editorWorkspace.handleAutosaveFocusChange}
								onReloadActiveTab={editorWorkspace.handleReloadActiveTab}
								onCancelDiscardPrompt={editorWorkspace.handleCancelDiscardPrompt}
								onConfirmDiscardPrompt={editorWorkspace.handleConfirmDiscardPrompt}
							/>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
