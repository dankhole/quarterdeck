import { FolderOpen, PanelLeft } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FileBrowserTreePanel } from "@/components/git/panels/file-browser-tree-panel";
import { FileContentViewer } from "@/components/git/panels/file-content-viewer";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { UseFileBrowserDataResult } from "@/hooks/git/use-file-browser-data";
import { ResizeHandle } from "@/resize/resize-handle";
import { clampBetween } from "@/resize/resize-persistence";
import {
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { useResizeDrag } from "@/resize/use-resize-drag";
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
	/** File browser data from useFileBrowserData — file list, selection, content. */
	fileBrowserData: UseFileBrowserDataResult;
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
	fileBrowserData,
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
	const { startDrag: startFileTreeResize } = useResizeDrag();

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

	// --- Render ---

	const hasFiles = (fileBrowserData.files?.length ?? 0) > 0;

	return (
		<div className="flex flex-col flex-1 min-h-0 min-w-0">
			{/* Scope bar slot */}
			{scopeBar}

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
				{!hasFiles && !fileBrowserData.selectedPath ? (
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
										selectedPath={fileBrowserData.selectedPath}
										onSelectPath={fileBrowserData.onSelectPath}
										panelFlex="1 1 0"
										expandedDirs={expandedDirs}
										onExpandedDirsChange={setExpandedDirs}
										hasInitializedExpansion={hasInitializedExpansion}
										onInitializedExpansion={handleInitializedExpansion}
										rootPath={rootPath}
										getFileContent={fileBrowserData.getFileContent}
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
							<FileContentViewer
								content={fileBrowserData.fileContent?.content ?? null}
								binary={fileBrowserData.fileContent?.binary ?? false}
								truncated={fileBrowserData.fileContent?.truncated ?? false}
								isLoading={fileBrowserData.isContentLoading}
								isError={fileBrowserData.isContentError}
								filePath={fileBrowserData.selectedPath}
								onClose={fileBrowserData.onCloseFile}
								scrollToLine={pendingScrollLine}
								onScrollToLineConsumed={() => setPendingScrollLine(null)}
							/>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
