import * as ContextMenu from "@radix-ui/react-context-menu";
import { ChevronDown, ChevronRight, Command, CornerDownLeft, Undo2 } from "lucide-react";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CONTEXT_MENU_ITEM_CLASS, FileContextMenuItems } from "@/components/git/panels/context-menu-utils";
import { truncatePathMiddle } from "@/components/shared/diff-renderer";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useDiffComments } from "@/hooks/git/use-diff-comments";
import { useDiffScrollSync } from "@/hooks/git/use-diff-scroll-sync";
import type { FileNavigation } from "@/hooks/git/use-git-navigation";
import type { RuntimeWorkdirFileChange } from "@/runtime/types";
import type { FileLoadingState } from "@/runtime/use-all-file-diff-content";
import { isBinaryFilePath } from "@/utils/is-binary-file-path";
import { isMacPlatform } from "@/utils/platform";

import { SplitDiff } from "./diff-split";
import { UnifiedDiff } from "./diff-unified";
import {
	type DiffLineComment,
	type DiffViewMode,
	type FileDiffGroup,
	flattenFilePathsForDisplay,
	getVisibleDiffGroupPaths,
} from "./diff-viewer-utils";

export type { DiffLineComment, DiffViewMode } from "./diff-viewer-utils";

const VISIBLE_DIFF_PATH_OVERSCAN_PX = 360;

function arePathListsEqual(previous: readonly string[], next: readonly string[]): boolean {
	return previous.length === next.length && previous.every((path, index) => path === next[index]);
}

export function DiffViewerPanel({
	projectFiles,
	selectedPath,
	onSelectedPathChange,
	onVisiblePathsChange,
	onAddToTerminal,
	onSendToTerminal,
	onRollbackFile,
	comments,
	onCommentsChange,
	viewMode = "unified",
	navigateToFile,
	isContentLoading,
	fileLoadingState,
}: {
	projectFiles: RuntimeWorkdirFileChange[] | null;
	selectedPath: string | null;
	onSelectedPathChange: (path: string) => void;
	onVisiblePathsChange?: (paths: string[]) => void;
	onAddToTerminal?: (formatted: string) => void;
	onSendToTerminal?: (formatted: string) => void;
	onRollbackFile?: (path: string) => void;
	comments: Map<string, DiffLineComment>;
	onCommentsChange: (comments: Map<string, DiffLineComment>) => void;
	viewMode?: DiffViewMode;
	navigateToFile?: (nav: FileNavigation) => void;
	/** @deprecated Use fileLoadingState instead. Kept for backward compatibility (git-history-view). */
	isContentLoading?: boolean;
	/** Per-file loading state from useAllFileDiffContent. When provided, shows per-file skeletons. */
	fileLoadingState?: FileLoadingState;
}): React.ReactElement {
	const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
	const lastReportedVisiblePathsRef = useRef<string[]>([]);

	const fileStatusByPath = useMemo(() => {
		const map = new Map<string, string>();
		for (const file of projectFiles ?? []) {
			map.set(file.path, file.status);
		}
		return map;
	}, [projectFiles]);

	const diffEntries = useMemo(() => {
		return (projectFiles ?? []).map((file, index) => ({
			id: `project-${file.path}-${index}`,
			path: file.path,
			isBinary: isBinaryFilePath(file.path),
			oldText: file.oldText,
			newText: file.newText ?? "",
			additions: file.additions,
			deletions: file.deletions,
			timestamp: 0,
			toolTitle: `${file.status} (${file.additions}+/${file.deletions}-)`,
		}));
	}, [projectFiles]);

	const groupedByPath = useMemo((): FileDiffGroup[] => {
		const sourcePaths = projectFiles?.map((file) => file.path) ?? [];
		const orderedPaths = flattenFilePathsForDisplay(sourcePaths);
		const orderIndex = new Map(orderedPaths.map((path, index) => [path, index]));
		const map = new Map<string, FileDiffGroup>();
		for (const entry of diffEntries) {
			let group = map.get(entry.path);
			if (!group) {
				group = {
					path: entry.path,
					entries: [],
					added: 0,
					removed: 0,
				};
				map.set(entry.path, group);
			}
			group.entries.push({
				id: entry.id,
				isBinary: entry.isBinary,
				oldText: entry.oldText,
				newText: entry.newText,
			});
			if (!entry.isBinary) {
				group.added += entry.additions;
				group.removed += entry.deletions;
			}
		}
		return Array.from(map.values()).sort((a, b) => {
			const aIndex = orderIndex.get(a.path) ?? Number.MAX_SAFE_INTEGER;
			const bIndex = orderIndex.get(b.path) ?? Number.MAX_SAFE_INTEGER;
			if (aIndex !== bIndex) {
				return aIndex - bIndex;
			}
			return a.path.localeCompare(b.path);
		});
	}, [diffEntries, projectFiles]);

	const { scrollContainerRef, sectionElementsRef, handleDiffScroll, suppressScrollSyncUntilRef } = useDiffScrollSync({
		groupedByPath,
		selectedPath,
		onSelectedPathChange,
	});

	const reportVisiblePaths = useCallback(() => {
		if (!onVisiblePathsChange) {
			return;
		}
		const container = scrollContainerRef.current;
		if (!container) {
			return;
		}
		const visiblePaths = getVisibleDiffGroupPaths({
			container,
			groupedByPath,
			sectionElements: sectionElementsRef.current,
			overscanPx: VISIBLE_DIFF_PATH_OVERSCAN_PX,
		});
		if (arePathListsEqual(lastReportedVisiblePathsRef.current, visiblePaths)) {
			return;
		}
		lastReportedVisiblePathsRef.current = visiblePaths;
		onVisiblePathsChange(visiblePaths);
	}, [groupedByPath, onVisiblePathsChange, scrollContainerRef, sectionElementsRef]);

	const handlePanelScroll = useCallback(() => {
		handleDiffScroll();
		reportVisiblePaths();
	}, [handleDiffScroll, reportVisiblePaths]);

	useEffect(() => {
		reportVisiblePaths();
		const frame = window.requestAnimationFrame(reportVisiblePaths);
		return () => {
			window.cancelAnimationFrame(frame);
		};
	}, [reportVisiblePaths, selectedPath]);

	const {
		handleAddComment,
		handleUpdateComment,
		handleDeleteComment,
		handleAddComments,
		handleSendComments,
		handleClearAllComments,
		hasAnyComments,
		nonEmptyCount,
	} = useDiffComments({
		comments,
		onCommentsChange,
		onAddToTerminal,
		onSendToTerminal,
	});

	/** Returns true when a file's diff content hasn't loaded yet. */
	const isFileLoading = useCallback(
		(path: string): boolean => {
			// New per-file loading state (batch mode from git-view).
			if (fileLoadingState) {
				// If the file is in the loaded set, it's done.
				if (fileLoadingState.loaded.has(path)) return false;
				// If it's in the loading set, it's actively being fetched.
				if (fileLoadingState.loading.has(path)) return true;
				// Not in either set yet — check if the file has content already (from cache).
				const group = groupedByPath.find((g) => g.path === path);
				if (group) {
					const hasContent = group.entries.some((e) => e.oldText != null || e.newText !== "");
					if (hasContent) return false;
				}
				// No content and not loaded — it's pending fetch.
				return true;
			}
			// Legacy single-file mode (git-history-view).
			return isContentLoading === true && selectedPath === path;
		},
		[fileLoadingState, isContentLoading, selectedPath, groupedByPath],
	);

	return (
		<div
			style={{
				display: "flex",
				flex: "1 1 0",
				flexDirection: "column",
				minWidth: 0,
				minHeight: 0,
				background: "var(--color-surface-0)",
			}}
		>
			{groupedByPath.length === 0 ? (
				<div className="kb-empty-state-center" style={{ flex: 1 }}>
					<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
						<svg
							width="40"
							height="40"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<rect x="3" y="3" width="8" height="18" rx="1" />
							<rect x="13" y="3" width="8" height="18" rx="1" />
						</svg>
					</div>
				</div>
			) : (
				<>
					<div
						ref={scrollContainerRef}
						onScroll={handlePanelScroll}
						style={{
							flex: "1 1 0",
							minHeight: 0,
							overflowY: "auto",
							overscrollBehavior: "contain",
							padding: "0 12px 12px",
						}}
					>
						{groupedByPath.map((group) => {
							const isExpanded = expandedPaths[group.path] ?? true;
							const hasBinaryEntry = group.entries.some((entry) => entry.isBinary);
							const fileStatus = fileStatusByPath.get(group.path);
							const canRollback = fileStatus !== "renamed" && fileStatus !== "copied";
							return (
								<section
									key={group.path}
									ref={(node) => {
										sectionElementsRef.current[group.path] = node;
									}}
									style={{ marginTop: 12 }}
								>
									<ContextMenu.Root>
										<ContextMenu.Trigger asChild>
											<button
												type="button"
												className="kb-diff-file-header flex w-full items-center gap-2 rounded-t-md border border-border bg-surface-1 px-2 py-1.5 text-left text-[12px] text-text-primary hover:bg-surface-3 active:bg-surface-4 cursor-pointer"
												aria-expanded={isExpanded}
												aria-current={selectedPath === group.path ? "true" : undefined}
												onClick={() => {
													const container = scrollContainerRef.current;
													const sectionEl = sectionElementsRef.current[group.path];
													const previousTop = sectionEl?.getBoundingClientRect().top ?? null;
													const nextExpanded = !(expandedPaths[group.path] ?? true);
													suppressScrollSyncUntilRef.current = Date.now() + 250;
													setExpandedPaths((prev) => ({
														...prev,
														[group.path]: nextExpanded,
													}));
													requestAnimationFrame(() => {
														if (previousTop == null || !container || !sectionEl) {
															return;
														}
														const nextTop = sectionEl.getBoundingClientRect().top;
														container.scrollTop += nextTop - previousTop;
													});
												}}
											>
												{isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
												<span
													className="truncate"
													title={group.path}
													style={{ flex: "1 1 auto", minWidth: 0 }}
												>
													{truncatePathMiddle(group.path)}
												</span>
												<span style={{ flexShrink: 0 }}>
													<span className="text-status-green">+{group.added}</span>{" "}
													<span className="text-status-red">-{group.removed}</span>
													{group.added === 0 && group.removed === 0 && hasBinaryEntry ? (
														<span className="ml-2 text-text-tertiary">Binary</span>
													) : null}
												</span>
											</button>
										</ContextMenu.Trigger>
										<ContextMenu.Portal>
											<FileContextMenuItems
												fileName={group.path.split("/").pop() ?? group.path}
												filePath={group.path}
												navigateToFile={navigateToFile}
											>
												{onRollbackFile ? (
													<>
														<ContextMenu.Separator className="h-px bg-border my-1" />
														<ContextMenu.Item
															className={cn(
																CONTEXT_MENU_ITEM_CLASS,
																canRollback ? "text-status-red" : "opacity-50",
															)}
															disabled={!canRollback}
															onSelect={canRollback ? () => onRollbackFile(group.path) : undefined}
														>
															<Undo2
																size={14}
																className={canRollback ? "text-status-red" : "text-text-tertiary"}
															/>
															{canRollback ? "Rollback" : "Cannot rollback renamed/copied"}
														</ContextMenu.Item>
													</>
												) : null}
											</FileContextMenuItems>
										</ContextMenu.Portal>
									</ContextMenu.Root>
									{isExpanded ? (
										<div
											className="rounded-b-md border-x border-b border-border bg-surface-1"
											style={{ overflow: "hidden" }}
										>
											{isFileLoading(group.path) ? (
												<div className="px-4 py-6">
													<div className="kb-skeleton h-3 rounded-sm mb-2" style={{ width: "95%" }} />
													<div className="kb-skeleton h-3 rounded-sm mb-2" style={{ width: "82%" }} />
													<div className="kb-skeleton h-3 rounded-sm mb-2" style={{ width: "90%" }} />
													<div className="kb-skeleton h-3 rounded-sm mb-2" style={{ width: "78%" }} />
													<div className="kb-skeleton h-3 rounded-sm" style={{ width: "85%" }} />
												</div>
											) : (
												group.entries.map((entry) => (
													<div key={entry.id} className="kb-diff-entry">
														{entry.isBinary ? null : viewMode === "split" ? (
															<SplitDiff
																path={group.path}
																oldText={entry.oldText}
																newText={entry.newText}
																comments={comments}
																onAddComment={(lineNumber, lineText, variant) =>
																	handleAddComment(group.path, lineNumber, lineText, variant)
																}
																onUpdateComment={(lineNumber, variant, text) =>
																	handleUpdateComment(group.path, lineNumber, variant, text)
																}
																onDeleteComment={(lineNumber, variant) =>
																	handleDeleteComment(group.path, lineNumber, variant)
																}
															/>
														) : (
															<UnifiedDiff
																path={group.path}
																oldText={entry.oldText}
																newText={entry.newText}
																comments={comments}
																onAddComment={(lineNumber, lineText, variant) =>
																	handleAddComment(group.path, lineNumber, lineText, variant)
																}
																onUpdateComment={(lineNumber, variant, text) =>
																	handleUpdateComment(group.path, lineNumber, variant, text)
																}
																onDeleteComment={(lineNumber, variant) =>
																	handleDeleteComment(group.path, lineNumber, variant)
																}
															/>
														)}
													</div>
												))
											)}
										</div>
									) : null}
								</section>
							);
						})}
					</div>
					{hasAnyComments && (onAddToTerminal || onSendToTerminal) ? (
						<div className="kb-diff-comments-footer">
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<span className="kb-diff-comments-count text-text-secondary">
									{nonEmptyCount} {nonEmptyCount === 1 ? "comment" : "comments"}
								</span>
								<Button variant="danger" size="sm" onClick={handleClearAllComments}>
									Clear All
								</Button>
							</div>
							<div style={{ display: "flex", gap: 4 }}>
								{onAddToTerminal ? (
									<Button
										variant="default"
										size="sm"
										disabled={nonEmptyCount === 0}
										onClick={handleAddComments}
									>
										<span style={{ display: "inline-flex", alignItems: "center" }}>
											<span>Add</span>
											<span
												style={{
													display: "inline-flex",
													alignItems: "center",
													gap: 2,
													marginLeft: 6,
												}}
												aria-hidden
											>
												{isMacPlatform ? <Command size={12} /> : <span style={{ fontSize: 12 }}>Ctrl</span>}
												<CornerDownLeft size={12} />
											</span>
										</span>
									</Button>
								) : null}
								{onSendToTerminal ? (
									<Button
										variant="primary"
										size="sm"
										disabled={nonEmptyCount === 0}
										onClick={handleSendComments}
									>
										<span style={{ display: "inline-flex", alignItems: "center" }}>
											<span>Send</span>
											<span
												style={{
													display: "inline-flex",
													alignItems: "center",
													gap: 2,
													marginLeft: 6,
												}}
												aria-hidden
											>
												{isMacPlatform ? <Command size={12} /> : <span style={{ fontSize: 12 }}>Ctrl</span>}
												<span style={{ fontSize: 12 }}>Shift</span>
												<CornerDownLeft size={12} />
											</span>
										</span>
									</Button>
								) : null}
							</div>
						</div>
					) : null}
				</>
			)}
		</div>
	);
}
