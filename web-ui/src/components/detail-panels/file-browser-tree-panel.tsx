import * as ContextMenu from "@radix-ui/react-context-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	ClipboardCopy,
	FileText,
	FolderOpen,
	Search,
	X,
} from "lucide-react";
import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { CONTEXT_MENU_ITEM_CLASS, FileContextMenuItems } from "@/components/detail-panels/context-menu-utils";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeFileContentResponse } from "@/runtime/types";
import { buildFileTree, type FileTreeNode } from "@/utils/file-tree";
import { useDebouncedEffect } from "@/utils/react-use";

interface FlatTreeItem {
	node: FileTreeNode;
	depth: number;
}

/** Single-pass traversal that produces both the visible item list and the file-only path list. */
function flattenVisible(nodes: FileTreeNode[], expandedDirs: Set<string>, depth: number, items: FlatTreeItem[]): void {
	for (const node of nodes) {
		items.push({ node, depth });
		if (node.type === "directory" && expandedDirs.has(node.path) && node.children.length > 0) {
			flattenVisible(node.children, expandedDirs, depth + 1, items);
		}
	}
}

const INITIAL_EXPANSION_DEPTH = 0;

function collectDirectoryPaths(nodes: FileTreeNode[], maxDepth = Number.POSITIVE_INFINITY, depth = 0): string[] {
	if (depth >= maxDepth) {
		return [];
	}
	const paths: string[] = [];
	for (const node of nodes) {
		if (node.type === "directory") {
			paths.push(node.path);
			paths.push(...collectDirectoryPaths(node.children, maxDepth, depth + 1));
		}
	}
	return paths;
}

const ROW_HEIGHT = 28;

export function FileBrowserTreePanel({
	files,
	selectedPath,
	onSelectPath,
	panelFlex,
	expandedDirs,
	onExpandedDirsChange,
	hasInitializedExpansion,
	onInitializedExpansion,
	rootPath,
	getFileContent,
}: {
	files: string[] | null;
	selectedPath: string | null;
	onSelectPath: (path: string | null) => void;
	panelFlex?: string;
	expandedDirs: Set<string>;
	onExpandedDirsChange: (value: SetStateAction<Set<string>>) => void;
	hasInitializedExpansion: boolean;
	onInitializedExpansion: () => void;
	/** Absolute path to the worktree/project root, used for "Copy path" context menu action. */
	rootPath?: string | null;
	/** Fetch file content for a given path (used by "Copy file contents" context menu action). */
	getFileContent?: (path: string) => Promise<RuntimeFileContentResponse | null>;
}): React.ReactElement {
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [focusedIndex, setFocusedIndex] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);

	const copyFileContents = useCallback(
		async (path: string) => {
			if (!getFileContent) return;
			try {
				const result = await getFileContent(path);
				if (!result) {
					showAppToast({ intent: "danger", message: "Failed to copy file contents" });
					return;
				}
				if (result.binary) {
					showAppToast({ intent: "danger", message: "Cannot copy binary file contents" });
					return;
				}
				await navigator.clipboard.writeText(result.content);
				showAppToast({ intent: "success", message: "File contents copied to clipboard" });
			} catch {
				showAppToast({ intent: "danger", message: "Failed to copy file contents" });
			}
		},
		[getFileContent],
	);

	useDebouncedEffect(
		() => {
			setDebouncedQuery(searchQuery);
		},
		150,
		[searchQuery],
	);

	const filteredFiles = useMemo(() => {
		const allFiles = files ?? [];
		if (!debouncedQuery.trim()) {
			return allFiles;
		}
		const query = debouncedQuery.toLowerCase();
		return allFiles.filter((path) => path.toLowerCase().includes(query));
	}, [files, debouncedQuery]);

	const tree = useMemo(() => buildFileTree(filteredFiles), [filteredFiles]);

	// Auto-expand directories on first load (limited depth) or fully when searching
	useEffect(() => {
		if (debouncedQuery.trim()) {
			onExpandedDirsChange(new Set(collectDirectoryPaths(tree)));
		} else if (!hasInitializedExpansion && tree.length > 0) {
			onExpandedDirsChange(new Set(collectDirectoryPaths(tree, INITIAL_EXPANSION_DEPTH)));
			onInitializedExpansion();
		}
	}, [tree, debouncedQuery, hasInitializedExpansion, onExpandedDirsChange, onInitializedExpansion]);

	const visibleItems = useMemo(() => {
		const items: FlatTreeItem[] = [];
		flattenVisible(tree, expandedDirs, 0, items);
		return items;
	}, [tree, expandedDirs]);

	const focusedItem =
		focusedIndex >= 0 && focusedIndex < visibleItems.length ? (visibleItems[focusedIndex] ?? null) : null;
	const focusedPath = focusedItem?.node.path ?? null;

	const allDirectoryPaths = useMemo(() => collectDirectoryPaths(tree), [tree]);
	const hasDirectories = allDirectoryPaths.length > 0;

	const handleExpandAll = useCallback(() => {
		onExpandedDirsChange(new Set(allDirectoryPaths));
	}, [allDirectoryPaths, onExpandedDirsChange]);

	const handleCollapseAll = useCallback(() => {
		onExpandedDirsChange(new Set());
	}, [onExpandedDirsChange]);

	const toggleDirectory = useCallback(
		(dirPath: string) => {
			onExpandedDirsChange((prev) => {
				const next = new Set(prev);
				if (next.has(dirPath)) {
					next.delete(dirPath);
				} else {
					next.add(dirPath);
				}
				return next;
			});
		},
		[onExpandedDirsChange],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === "Escape") {
				if (searchQuery) {
					event.preventDefault();
					event.stopPropagation();
					setSearchQuery("");
					setFocusedIndex(-1);
				} else {
					inputRef.current?.blur();
				}
				return;
			}
			if (visibleItems.length === 0) {
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setFocusedIndex((prev) => (prev + 1 < visibleItems.length ? prev + 1 : 0));
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setFocusedIndex((prev) => (prev > 0 ? prev - 1 : visibleItems.length - 1));
			} else if (event.key === "Enter" && focusedItem) {
				event.preventDefault();
				if (focusedItem.node.type === "directory") {
					toggleDirectory(focusedItem.node.path);
				} else {
					onSelectPath(focusedItem.node.path);
				}
			}
		},
		[visibleItems, focusedItem, onSelectPath, searchQuery, toggleDirectory],
	);

	const handleSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		setSearchQuery(event.target.value);
		setFocusedIndex(-1);
	}, []);

	const handleClearSearch = useCallback(() => {
		setSearchQuery("");
		setFocusedIndex(-1);
		inputRef.current?.focus();
	}, []);

	const virtualizer = useVirtualizer({
		count: visibleItems.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 20,
	});

	return (
		<div className="flex flex-col min-w-0 min-h-0 bg-surface-0" style={{ flex: panelFlex ?? "0.6 1 0" }}>
			{(files?.length ?? 0) > 0 ? (
				<div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
					<Search size={12} className="text-text-tertiary shrink-0" />
					<input
						ref={inputRef}
						type="text"
						value={searchQuery}
						onChange={handleSearchChange}
						onKeyDown={handleKeyDown}
						placeholder="Filter files..."
						className="flex-1 min-w-0 bg-transparent text-xs text-text-primary placeholder-text-tertiary outline-none border-0 p-0"
					/>
					{searchQuery ? (
						<button
							type="button"
							onClick={handleClearSearch}
							className="text-text-tertiary hover:text-text-secondary"
						>
							<X size={12} />
						</button>
					) : null}
					{hasDirectories ? (
						<>
							<Tooltip content="Expand all">
								<button
									type="button"
									onClick={handleExpandAll}
									className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary"
								>
									<ChevronsUpDown size={12} />
								</button>
							</Tooltip>
							<Tooltip content="Collapse all">
								<button
									type="button"
									onClick={handleCollapseAll}
									className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary"
								>
									<ChevronsDownUp size={12} />
								</button>
							</Tooltip>
						</>
					) : null}
				</div>
			) : null}
			<div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2">
				{visibleItems.length === 0 ? (
					<div className="kb-empty-state-center">
						<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
							<FolderOpen size={40} />
							<span className="text-sm">{searchQuery ? "No matching files" : "No files"}</span>
						</div>
					</div>
				) : (
					<div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
						{virtualizer.getVirtualItems().map((virtualItem) => {
							const item = visibleItems[virtualItem.index]!;
							const { node, depth } = item;
							const isDirectory = node.type === "directory";
							const isExpanded = expandedDirs.has(node.path);
							const isSelected = !isDirectory && node.path === selectedPath;
							const isFocused = node.path === focusedPath;

							return (
								<ContextMenu.Root key={node.path}>
									<ContextMenu.Trigger asChild>
										<button
											type="button"
											className={cn(
												"kb-file-tree-row absolute top-0 left-0 w-full",
												isDirectory && "kb-file-tree-row-directory",
												isSelected && "kb-file-tree-row-selected",
												isFocused && !isSelected && "ring-1 ring-inset ring-border-focus",
											)}
											style={{
												height: ROW_HEIGHT,
												transform: `translateY(${virtualItem.start}px)`,
												paddingLeft: depth * 12 + 8,
											}}
											onClick={() => {
												if (isDirectory) {
													toggleDirectory(node.path);
												} else {
													onSelectPath(node.path);
												}
											}}
										>
											{isDirectory ? (
												isExpanded ? (
													<ChevronDown size={12} className="shrink-0" />
												) : (
													<ChevronRight size={12} className="shrink-0" />
												)
											) : null}
											{isDirectory ? <FolderOpen size={14} /> : <FileText size={14} />}
											<span className="truncate">{node.name}</span>
										</button>
									</ContextMenu.Trigger>
									<ContextMenu.Portal>
										<FileContextMenuItems
											fileName={node.name}
											filePath={rootPath ? `${rootPath}/${node.path}` : node.path}
										>
											{!isDirectory && getFileContent ? (
												<ContextMenu.Item
													className={CONTEXT_MENU_ITEM_CLASS}
													onSelect={() => void copyFileContents(node.path)}
												>
													<ClipboardCopy size={14} className="text-text-secondary" />
													Copy file contents
												</ContextMenu.Item>
											) : null}
										</FileContextMenuItems>
									</ContextMenu.Portal>
								</ContextMenu.Root>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
