import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, FileText, FolderOpen, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { buildFileTree, type FileTreeNode } from "@/utils/file-tree";
import { useDebouncedEffect } from "@/utils/react-use";

interface FlatTreeItem {
	node: FileTreeNode;
	depth: number;
}

function flattenVisibleNodes(nodes: FileTreeNode[], expandedDirs: Set<string>, depth: number): FlatTreeItem[] {
	const result: FlatTreeItem[] = [];
	for (const node of nodes) {
		result.push({ node, depth });
		if (node.type === "directory" && expandedDirs.has(node.path) && node.children.length > 0) {
			result.push(...flattenVisibleNodes(node.children, expandedDirs, depth + 1));
		}
	}
	return result;
}

function collectAllDirectoryPaths(nodes: FileTreeNode[]): string[] {
	const paths: string[] = [];
	for (const node of nodes) {
		if (node.type === "directory") {
			paths.push(node.path);
			paths.push(...collectAllDirectoryPaths(node.children));
		}
	}
	return paths;
}

function flattenFilePaths(nodes: FileTreeNode[], expandedDirs: Set<string>): string[] {
	const result: string[] = [];
	for (const node of nodes) {
		if (node.type === "file") {
			result.push(node.path);
		}
		if (node.type === "directory" && expandedDirs.has(node.path) && node.children.length > 0) {
			result.push(...flattenFilePaths(node.children, expandedDirs));
		}
	}
	return result;
}

const ROW_HEIGHT = 28;

export function FileBrowserTreePanel({
	files,
	selectedPath,
	onSelectPath,
	panelFlex,
}: {
	files: string[] | null;
	selectedPath: string | null;
	onSelectPath: (path: string | null) => void;
	panelFlex?: string;
}): React.ReactElement {
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [focusedIndex, setFocusedIndex] = useState(-1);
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const [hasInitializedExpansion, setHasInitializedExpansion] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);

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

	// Auto-expand all directories on first load or when searching
	useEffect(() => {
		if (debouncedQuery.trim()) {
			setExpandedDirs(new Set(collectAllDirectoryPaths(tree)));
		} else if (!hasInitializedExpansion && tree.length > 0) {
			setExpandedDirs(new Set(collectAllDirectoryPaths(tree)));
			setHasInitializedExpansion(true);
		}
	}, [tree, debouncedQuery, hasInitializedExpansion]);

	const visibleItems = useMemo(() => flattenVisibleNodes(tree, expandedDirs, 0), [tree, expandedDirs]);
	const flatFilePaths = useMemo(() => flattenFilePaths(tree, expandedDirs), [tree, expandedDirs]);

	const focusedPath =
		focusedIndex >= 0 && focusedIndex < flatFilePaths.length ? (flatFilePaths[focusedIndex] ?? null) : null;

	const toggleDirectory = useCallback((dirPath: string) => {
		setExpandedDirs((prev) => {
			const next = new Set(prev);
			if (next.has(dirPath)) {
				next.delete(dirPath);
			} else {
				next.add(dirPath);
			}
			return next;
		});
	}, []);

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
			if (flatFilePaths.length === 0) {
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setFocusedIndex((prev) => (prev + 1 < flatFilePaths.length ? prev + 1 : 0));
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setFocusedIndex((prev) => (prev > 0 ? prev - 1 : flatFilePaths.length - 1));
			} else if (event.key === "Enter" && focusedPath) {
				event.preventDefault();
				onSelectPath(focusedPath);
			}
		},
		[flatFilePaths, focusedPath, onSelectPath, searchQuery],
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
						className="flex-1 bg-transparent text-xs text-text-primary placeholder-text-tertiary outline-none border-0 p-0"
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
							const isFocused = !isDirectory && node.path === focusedPath;

							return (
								<button
									key={node.path}
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
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
