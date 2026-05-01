import * as ContextMenu from "@radix-ui/react-context-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	ClipboardCopy,
	FilePlus,
	FileText,
	FolderOpen,
	FolderPlus,
	Pencil,
	Search,
	Trash2,
	X,
} from "lucide-react";
import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import {
	CONTEXT_MENU_ITEM_CLASS,
	copyToClipboard,
	FileContextMenuItems,
} from "@/components/git/panels/context-menu-utils";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription, Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import type {
	RuntimeFileContentResponse,
	RuntimeWorkdirEntryKind,
	RuntimeWorkdirEntryMutationResponse,
} from "@/runtime/types";
import { buildFileTree, type FileTreeNode } from "@/utils/file-tree";
import { useDebouncedEffect } from "@/utils/react-use";

interface FlatTreeItem {
	node: FileTreeNode;
	depth: number;
}

type EntryFormDialogState =
	| {
			mode: "create";
			kind: RuntimeWorkdirEntryKind;
			value: string;
	  }
	| {
			mode: "rename";
			kind: RuntimeWorkdirEntryKind;
			path: string;
			value: string;
	  };

interface DeleteEntryPrompt {
	path: string;
	kind: RuntimeWorkdirEntryKind;
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

/** Module-level cache of scroll positions per scope key. */
const scrollPositionByScope = new Map<string, number>();

function parentPathOf(path: string): string | null {
	const index = path.lastIndexOf("/");
	return index < 0 ? null : path.slice(0, index);
}

function entryKindLabel(kind: RuntimeWorkdirEntryKind): string {
	return kind === "directory" ? "folder" : "file";
}

export function FileBrowserTreePanel({
	files,
	directories,
	selectedPath,
	onSelectPath,
	panelFlex,
	expandedDirs,
	onExpandedDirsChange,
	hasInitializedExpansion,
	onInitializedExpansion,
	rootPath,
	getFileContent,
	onCreateEntry,
	onRenameEntry,
	onDeleteEntry,
	scopeKey,
}: {
	files: string[] | null;
	directories?: string[] | null;
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
	onCreateEntry?: (path: string, kind: RuntimeWorkdirEntryKind) => Promise<RuntimeWorkdirEntryMutationResponse>;
	onRenameEntry?: (
		path: string,
		nextPath: string,
		kind: RuntimeWorkdirEntryKind,
	) => Promise<RuntimeWorkdirEntryMutationResponse>;
	onDeleteEntry?: (path: string, kind: RuntimeWorkdirEntryKind) => Promise<RuntimeWorkdirEntryMutationResponse>;
	/** Scope key for persisting scroll position across unmount/remount cycles. */
	scopeKey?: string;
}): React.ReactElement {
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [focusedIndex, setFocusedIndex] = useState(-1);
	// TODO(editor-lite): Extract entry mutation dialogs/handlers when file operations add more flows.
	const [entryFormDialog, setEntryFormDialog] = useState<EntryFormDialogState | null>(null);
	const [deletePrompt, setDeletePrompt] = useState<DeleteEntryPrompt | null>(null);
	const [isMutatingEntry, setIsMutatingEntry] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);

	// Save scroll position on unmount so it can be restored when this scope remounts.
	useEffect(() => {
		const ref = scrollContainerRef;
		const key = scopeKey;
		return () => {
			if (key && ref.current) {
				scrollPositionByScope.set(key, ref.current.scrollTop);
			}
		};
	}, [scopeKey]);

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
				copyToClipboard(result.content, "File contents");
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

	const filteredDirectories = useMemo(() => {
		const allDirectories = directories ?? [];
		if (!debouncedQuery.trim()) {
			return allDirectories;
		}
		const query = debouncedQuery.toLowerCase();
		return allDirectories.filter((path) => path.toLowerCase().includes(query));
	}, [directories, debouncedQuery]);

	const tree = useMemo(() => buildFileTree(filteredFiles, filteredDirectories), [filteredFiles, filteredDirectories]);

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

	const openCreateEntryDialog = useCallback((kind: RuntimeWorkdirEntryKind, parentPath: string | null = null) => {
		setEntryFormDialog({ mode: "create", kind, value: parentPath ? `${parentPath}/` : "" });
	}, []);

	const openRenameEntryDialog = useCallback((path: string, kind: RuntimeWorkdirEntryKind) => {
		setEntryFormDialog({ mode: "rename", kind, path, value: path });
	}, []);

	const handleEntryFormSubmit = useCallback(
		async (event: React.FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			if (!entryFormDialog) return;
			const nextPath = entryFormDialog.value.trim();
			if (!nextPath) {
				showAppToast({ intent: "danger", message: "Path is required." });
				return;
			}
			setIsMutatingEntry(true);
			try {
				if (entryFormDialog.mode === "create") {
					if (!onCreateEntry) return;
					await onCreateEntry(nextPath, entryFormDialog.kind);
					showAppToast({ intent: "success", message: `${entryKindLabel(entryFormDialog.kind)} created.` });
				} else {
					if (!onRenameEntry) return;
					await onRenameEntry(entryFormDialog.path, nextPath, entryFormDialog.kind);
					showAppToast({ intent: "success", message: `${entryKindLabel(entryFormDialog.kind)} renamed.` });
				}
				setEntryFormDialog(null);
			} catch (error) {
				showAppToast({ intent: "danger", message: error instanceof Error ? error.message : String(error) });
			} finally {
				setIsMutatingEntry(false);
			}
		},
		[entryFormDialog, onCreateEntry, onRenameEntry],
	);

	const handleConfirmDeleteEntry = useCallback(async () => {
		if (!deletePrompt || !onDeleteEntry) return;
		setIsMutatingEntry(true);
		try {
			await onDeleteEntry(deletePrompt.path, deletePrompt.kind);
			showAppToast({ intent: "success", message: `${entryKindLabel(deletePrompt.kind)} deleted.` });
			setDeletePrompt(null);
		} catch (error) {
			showAppToast({ intent: "danger", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setIsMutatingEntry(false);
		}
	}, [deletePrompt, onDeleteEntry]);

	// FilesView wires entry mutation callbacks as an all-or-none capability for mutable worktree scopes.
	const canMutateEntries = Boolean(onCreateEntry || onRenameEntry || onDeleteEntry);

	const virtualizer = useVirtualizer({
		count: visibleItems.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 20,
		initialOffset: scopeKey ? (scrollPositionByScope.get(scopeKey) ?? 0) : 0,
	});

	return (
		<div className="flex flex-col min-w-0 min-h-0 bg-surface-0" style={{ flex: panelFlex ?? "0.6 1 0" }}>
			<Dialog open={entryFormDialog !== null} onOpenChange={(open) => !open && setEntryFormDialog(null)}>
				<DialogHeader
					title={
						entryFormDialog
							? `${entryFormDialog.mode === "create" ? "Create" : "Rename"} ${entryKindLabel(entryFormDialog.kind)}`
							: "File operation"
					}
				/>
				<form onSubmit={(event) => void handleEntryFormSubmit(event)}>
					<DialogBody className="flex flex-col gap-2">
						<label className="flex flex-col gap-1 text-xs text-text-secondary">
							Path
							<input
								name="workdir-entry-path"
								value={entryFormDialog?.value ?? ""}
								onChange={(event) =>
									setEntryFormDialog((current) =>
										current ? { ...current, value: event.target.value } : current,
									)
								}
								disabled={isMutatingEntry}
								autoFocus
								className="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm text-text-primary outline-none focus:border-border-focus"
							/>
						</label>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="default"
							onClick={() => setEntryFormDialog(null)}
							disabled={isMutatingEntry}
						>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={isMutatingEntry}>
							{entryFormDialog?.mode === "create" ? "Create" : "Rename"}
						</Button>
					</DialogFooter>
				</form>
			</Dialog>
			<ConfirmationDialog
				open={deletePrompt !== null}
				title={`Delete ${deletePrompt ? entryKindLabel(deletePrompt.kind) : "entry"}?`}
				confirmLabel="Delete"
				onCancel={() => setDeletePrompt(null)}
				onConfirm={() => void handleConfirmDeleteEntry()}
				isLoading={isMutatingEntry}
			>
				<AlertDialogDescription>
					{deletePrompt ? (
						<>
							Delete <span className="font-mono text-text-primary">{deletePrompt.path}</span>
							{deletePrompt.kind === "directory" ? " and everything inside it" : ""}?
						</>
					) : (
						"Delete this entry?"
					)}
				</AlertDialogDescription>
			</ConfirmationDialog>
			{(files?.length ?? 0) > 0 || (directories?.length ?? 0) > 0 || canMutateEntries ? (
				<div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
					<Search size={12} className="text-text-tertiary shrink-0" />
					<input
						ref={inputRef}
						name={scopeKey ? `file-filter-${scopeKey}` : "file-filter"}
						type="text"
						value={searchQuery}
						onChange={handleSearchChange}
						onKeyDown={handleKeyDown}
						placeholder="Filter files..."
						className="flex-1 min-w-0 bg-transparent text-xs text-text-primary placeholder-text-tertiary outline-none border-0 p-0"
					/>
					{canMutateEntries ? (
						<>
							<Tooltip content="New file">
								<button
									type="button"
									onClick={() => openCreateEntryDialog("file")}
									className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary"
								>
									<FilePlus size={12} />
								</button>
							</Tooltip>
							<Tooltip content="New folder">
								<button
									type="button"
									onClick={() => openCreateEntryDialog("directory")}
									className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary"
								>
									<FolderPlus size={12} />
								</button>
							</Tooltip>
						</>
					) : null}
					{searchQuery ? (
						<button
							type="button"
							onClick={handleClearSearch}
							className="shrink-0 rounded-md p-1 text-text-tertiary hover:text-text-primary hover:bg-surface-3"
							aria-label="Clear file filter"
						>
							<X size={14} />
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
											{canMutateEntries ? (
												<>
													<ContextMenu.Separator className="h-px bg-border my-1" />
													{isDirectory && onCreateEntry ? (
														<>
															<ContextMenu.Item
																className={CONTEXT_MENU_ITEM_CLASS}
																onSelect={() => openCreateEntryDialog("file", node.path)}
															>
																<FilePlus size={14} className="text-text-secondary" />
																New file
															</ContextMenu.Item>
															<ContextMenu.Item
																className={CONTEXT_MENU_ITEM_CLASS}
																onSelect={() => openCreateEntryDialog("directory", node.path)}
															>
																<FolderPlus size={14} className="text-text-secondary" />
																New folder
															</ContextMenu.Item>
														</>
													) : null}
													{!isDirectory && onCreateEntry ? (
														<ContextMenu.Item
															className={CONTEXT_MENU_ITEM_CLASS}
															onSelect={() => openCreateEntryDialog("file", parentPathOf(node.path))}
														>
															<FilePlus size={14} className="text-text-secondary" />
															New file
														</ContextMenu.Item>
													) : null}
													{onRenameEntry ? (
														<ContextMenu.Item
															className={CONTEXT_MENU_ITEM_CLASS}
															onSelect={() =>
																openRenameEntryDialog(node.path, isDirectory ? "directory" : "file")
															}
														>
															<Pencil size={14} className="text-text-secondary" />
															Rename / move
														</ContextMenu.Item>
													) : null}
													{onDeleteEntry ? (
														<ContextMenu.Item
															className={CONTEXT_MENU_ITEM_CLASS}
															onSelect={() =>
																setDeletePrompt({
																	path: node.path,
																	kind: isDirectory ? "directory" : "file",
																})
															}
														>
															<Trash2 size={14} className="text-status-red" />
															Delete
														</ContextMenu.Item>
													) : null}
												</>
											) : null}
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
