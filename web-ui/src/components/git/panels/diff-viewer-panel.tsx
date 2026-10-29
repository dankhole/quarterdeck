import * as ContextMenu from "@radix-ui/react-context-menu";
import { TASK_QUICK_REPLY_MAX_LENGTH } from "@runtime-contract";
import { ChevronDown, ChevronRight, Command, CornerDownLeft, Undo2 } from "lucide-react";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { ReviewDocumentDiff } from "@/components/editor/review-document-diff";
import { CONTEXT_MENU_ITEM_CLASS, FileContextMenuItems } from "@/components/git/panels/context-menu-utils";
import { truncatePathMiddle } from "@/components/shared/diff-renderer";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import type { CodeNavigationConfig } from "@/hooks/git/code-navigation";
import { createFileBrowserContentScopeKey } from "@/hooks/git/file-browser-scope";
import { createReviewDocument, type ReviewScope } from "@/hooks/git/review-document";
import { useDiffComments } from "@/hooks/git/use-diff-comments";
import { useDiffScrollSync } from "@/hooks/git/use-diff-scroll-sync";
import type { FileNavigation } from "@/hooks/git/use-git-navigation";
import { createWorkdirSearchScope } from "@/hooks/search/search-scope";
import type { RuntimeWorkdirFileChange } from "@/runtime/types";
import type { FileLoadingState } from "@/runtime/use-all-file-diff-content";
import { isBinaryFilePath } from "@/utils/is-binary-file-path";
import { isMacPlatform } from "@/utils/platform";
import { DiffScrollPreserver } from "./diff-scroll-preserver";
import {
	createDiffAnchorLookup,
	type DiffAnchorLookup,
	type DiffLineComment,
	type DiffViewMode,
	type FileDiffGroup,
	flattenFilePathsForDisplay,
	getVisibleDiffGroupPaths,
	InlineComment,
	isCommentAnchorValid,
} from "./diff-viewer-utils";

export type { DiffLineComment, DiffViewMode } from "./diff-viewer-utils";

const VISIBLE_DIFF_PATH_OVERSCAN_PX = 360;

function arePathListsEqual(previous: readonly string[], next: readonly string[]): boolean {
	return previous.length === next.length && previous.every((path, index) => path === next[index]);
}

export function DiffViewerPanel({
	projectFiles,
	reviewScope,
	agentContextSource,
	selectedPath,
	onSelectedPathChange,
	onVisiblePathsChange,
	onSendToTerminal,
	onRollbackFile,
	comments,
	reviewDraftKey,
	onCommentsChange,
	viewMode = "unified",
	navigateToFile,
	fileLoadingState,
	codeNavigationConfig,
	readOnlyReview = false,
}: {
	projectFiles: RuntimeWorkdirFileChange[] | null;
	reviewScope: ReviewScope;
	agentContextSource?: string;
	selectedPath: string | null;
	onSelectedPathChange: (path: string) => void;
	onVisiblePathsChange?: (paths: string[]) => void;
	onSendToTerminal?: (formatted: string) => Promise<{ ok: boolean; message?: string }>;
	onRollbackFile?: (path: string) => void;
	comments: Map<string, DiffLineComment>;
	reviewDraftKey?: string;
	onCommentsChange: (comments: Map<string, DiffLineComment>) => void;
	viewMode?: DiffViewMode;
	navigateToFile?: (nav: FileNavigation) => void;
	/** Per-file loading state from useAllFileDiffContent. When provided, shows per-file skeletons. */
	fileLoadingState?: FileLoadingState;
	codeNavigationConfig?: CodeNavigationConfig | null;
	readOnlyReview?: boolean;
}): React.ReactElement {
	const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
	const [confirmClear, setConfirmClear] = useState(false);
	const lastReportedVisiblePathsRef = useRef<string[]>([]);

	const fileByPath = useMemo(() => {
		const map = new Map<string, RuntimeWorkdirFileChange>();
		for (const file of projectFiles ?? []) {
			map.set(file.path, file);
		}
		return map;
	}, [projectFiles]);

	const diffEntries = useMemo(() => {
		return (projectFiles ?? []).map((file) => ({
			id: `project-${file.path}`,
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

	const groupsByPath = useMemo(() => new Map(groupedByPath.map((group) => [group.path, group])), [groupedByPath]);

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
		handleSaveComment,
		handleEditComment,
		handleCancelEditComment,
		handleSendComments,
		handleClearAllComments,
		hasAnyComments,
		nonEmptyCount,
		fileCount,
		formattedLength: payloadLength,
		isSending,
		sendError,
	} = useDiffComments({
		comments,
		reviewDraftKey,
		onCommentsChange,
		onSendToTerminal: readOnlyReview ? undefined : onSendToTerminal,
	});

	const exceedsPayloadLimit = payloadLength > TASK_QUICK_REPLY_MAX_LENGTH;
	const finalSendShortcutRef = useHotkeys<HTMLDivElement>(
		"meta+shift+enter,ctrl+shift+enter",
		(event) => {
			if (
				event.defaultPrevented ||
				event.isComposing ||
				confirmClear ||
				exceedsPayloadLimit ||
				isSending ||
				nonEmptyCount === 0 ||
				readOnlyReview ||
				!onSendToTerminal
			)
				return;
			event.preventDefault();
			event.stopPropagation();
			void handleSendComments();
		},
		{
			enabled:
				!readOnlyReview &&
				Boolean(onSendToTerminal) &&
				nonEmptyCount > 0 &&
				!isSending &&
				!confirmClear &&
				!exceedsPayloadLimit,
			enableOnFormTags: true,
			enableOnContentEditable: true,
			ignoreEventWhen: (event) => event.defaultPrevented,
		},
		[
			handleSendComments,
			isSending,
			nonEmptyCount,
			onSendToTerminal,
			readOnlyReview,
			confirmClear,
			exceedsPayloadLimit,
		],
	);

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
				const group = groupsByPath.get(path);
				if (group) {
					const hasContent = group.entries.some((e) => e.oldText != null || e.newText !== "");
					if (hasContent) return false;
				}
				// No content and not loaded — it's pending fetch.
				return true;
			}
			const file = fileByPath.get(path);
			return file != null && file.oldText == null && file.newText == null;
		},
		[fileLoadingState, groupsByPath, fileByPath],
	);

	const previousAnchorsRef = useRef(
		new Map<string, { oldText: string | null; newText: string; lookup: DiffAnchorLookup }>(),
	);
	const anchorLookups = useMemo(() => {
		const next = new Map<string, { oldText: string | null; newText: string; lookup: DiffAnchorLookup }>();
		for (const group of groupedByPath) {
			for (const entry of group.entries) {
				if (entry.isBinary) continue;
				// Optional render reuse only: exact contents admit reuse; recomputation is equally correct.
				const previous = previousAnchorsRef.current.get(entry.id);
				const anchor =
					previous?.oldText === entry.oldText && previous.newText === entry.newText
						? previous
						: {
								oldText: entry.oldText,
								newText: entry.newText,
								lookup: createDiffAnchorLookup(entry.oldText, entry.newText),
							};
				next.set(entry.id, anchor);
			}
		}
		previousAnchorsRef.current = next;
		return new Map(Array.from(next, ([id, anchor]) => [id, anchor.lookup]));
	}, [groupedByPath]);

	// Keep drafts reachable when their original line cannot currently be displayed.
	// Missing content is unknown, not evidence that an anchor is outdated.
	const detachedComments = useMemo(() => {
		return Array.from(comments.entries()).flatMap(([key, comment]) => {
			const group = groupsByPath.get(comment.filePath);
			let reason: string | null = null;
			if (!group) reason = projectFiles === null ? "Waiting for diff" : "Outdated — file no longer in this diff";
			else if (isFileLoading(comment.filePath)) reason = "Waiting for diff";
			else if (
				!group.entries.some((entry) => {
					const lookup = anchorLookups.get(entry.id);
					return lookup != null && isCommentAnchorValid(comment, lookup);
				})
			)
				reason = "Outdated — original line changed";
			else if (expandedPaths[comment.filePath] === false) reason = "File collapsed";
			return reason ? [{ key, comment, reason }] : [];
		});
	}, [comments, groupsByPath, projectFiles, isFileLoading, expandedPaths, anchorLookups]);

	return (
		<div
			ref={finalSendShortcutRef}
			tabIndex={-1}
			style={{
				display: "flex",
				flex: "1 1 0",
				flexDirection: "column",
				minWidth: 0,
				minHeight: 0,
				background: "var(--color-surface-0)",
			}}
		>
			<DiffScrollPreserver
				containerRef={scrollContainerRef}
				groups={groupedByPath}
				selectedPath={selectedPath}
				scopeKey={JSON.stringify([
					createFileBrowserContentScopeKey(reviewScope.repository),
					reviewScope.revisions.kind,
					reviewScope.revisions.base,
					reviewScope.revisions.head,
					reviewScope.revisions.mode,
				])}
			>
				<div
					ref={scrollContainerRef}
					data-diff-scroll-container
					onScroll={handlePanelScroll}
					style={{
						flex: "1 1 0",
						minHeight: 0,
						overflowY: "auto",
						overscrollBehavior: "contain",
						padding: "0 12px 12px",
					}}
				>
					{groupedByPath.length === 0 ? (
						<p className="py-8 text-center text-xs text-text-tertiary">No changes to display.</p>
					) : null}
					{!readOnlyReview && detachedComments.length > 0 ? (
						<section aria-label="Unanchored review drafts" className="my-3 rounded-md border border-border p-3">
							<h3 className="mb-2 text-xs font-medium text-text-secondary">Unanchored / outdated drafts</h3>
							{detachedComments.map(({ key, comment, reason }) => (
								<div key={key} className="mb-3">
									<p className="text-xs text-text-secondary">
										{reason} · {comment.filePath}:{comment.lineNumber} ({comment.variant})
									</p>
									<pre className="mt-1 whitespace-pre-wrap break-words text-xs text-text-tertiary">
										{comment.lineText}
									</pre>
									<InlineComment
										comment={comment}
										onChange={(text) =>
											handleUpdateComment(comment.filePath, comment.lineNumber, comment.variant, text, key)
										}
										onDelete={() =>
											handleDeleteComment(comment.filePath, comment.lineNumber, comment.variant, key)
										}
										onSave={() =>
											handleSaveComment(comment.filePath, comment.lineNumber, comment.variant, key)
										}
										onEdit={() =>
											handleEditComment(comment.filePath, comment.lineNumber, comment.variant, key)
										}
										onCancel={() =>
											handleCancelEditComment(comment.filePath, comment.lineNumber, comment.variant, key)
										}
									/>
								</div>
							))}
						</section>
					) : null}
					{groupedByPath.map((group) => {
						const isExpanded = expandedPaths[group.path] ?? true;
						const hasBinaryEntry = group.entries.some((entry) => entry.isBinary);
						const file = fileByPath.get(group.path);
						if (!file) return null;
						const fileStatus = file.status;
						const canRollback = fileStatus !== "renamed" && fileStatus !== "copied";
						return (
							<section
								key={group.path}
								data-diff-path={group.path}
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
											{onRollbackFile && !readOnlyReview ? (
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
													<ReviewDocumentDiff
														document={createReviewDocument(
															reviewScope,
															file,
															entry.isBinary
																? { kind: "binary" }
																: {
																		kind: "text",
																		oldText: entry.oldText,
																		newText: entry.newText,
																	},
														)}
														viewMode={viewMode}
														codeNavigation={{
															options: {
																projectId: reviewScope.repository.projectId,
																scope: createWorkdirSearchScope({
																	...reviewScope.repository,
																	ref: reviewScope.repository.ref ?? undefined,
																}),
																config: codeNavigationConfig ?? null,
															},
															onNavigate: (location) =>
																navigateToFile?.({
																	targetView: "files",
																	filePath: location.path,
																	codeLocation: location,
																	codeTaskId: reviewScope.repository.taskId,
																}),
														}}
														interactions={{
															readOnlyReview,
															agentContextSource,
															comments,
															anchorLookup: anchorLookups.get(entry.id),
															onAddComment: handleAddComment,
															onUpdateComment: handleUpdateComment,
															onDeleteComment: handleDeleteComment,
															onSaveComment: handleSaveComment,
															onEditComment: handleEditComment,
															onCancelEditComment: handleCancelEditComment,
														}}
													/>
												</div>
											))
										)}
									</div>
								) : null}
							</section>
						);
					})}
				</div>
			</DiffScrollPreserver>
			{!readOnlyReview && hasAnyComments ? (
				<div className="kb-diff-comments-footer flex-wrap gap-2">
					<div className="flex items-center gap-2">
						<span className="kb-diff-comments-count text-text-secondary">
							{nonEmptyCount} {nonEmptyCount === 1 ? "comment" : "comments"} across {fileCount}{" "}
							{fileCount === 1 ? "file" : "files"}
						</span>
						<Button
							variant="danger"
							size="sm"
							disabled={isSending}
							onClick={() => {
								if (nonEmptyCount > 0) setConfirmClear(true);
								else handleClearAllComments();
							}}
						>
							Clear all
						</Button>
					</div>
					{onSendToTerminal ? (
						<Button
							variant="primary"
							size="sm"
							disabled={nonEmptyCount === 0 || isSending || exceedsPayloadLimit}
							onClick={() => void handleSendComments()}
						>
							{isSending ? "Sending…" : "Send all comments"}
							<span className="ml-2 inline-flex items-center gap-1" aria-hidden>
								{isMacPlatform ? <Command size={12} /> : <span>Ctrl</span>}
								<span>Shift</span>
								<CornerDownLeft size={12} />
							</span>
						</Button>
					) : null}
					<p
						className={cn("w-full text-xs", exceedsPayloadLimit ? "text-status-red" : "text-text-tertiary")}
						role={exceedsPayloadLimit ? "alert" : undefined}
					>
						{payloadLength.toLocaleString()} / {TASK_QUICK_REPLY_MAX_LENGTH.toLocaleString()} characters
						{exceedsPayloadLimit ? " — shorten comments before sending. Nothing will be truncated or split." : ""}
					</p>
					{sendError ? (
						<p role="alert" className="w-full text-xs text-status-red">
							{sendError}
						</p>
					) : null}
				</div>
			) : null}
			<AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
				<AlertDialogHeader>
					<AlertDialogTitle>Clear all review comments?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						All unsent comments, including current editor text, will be deleted.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button size="sm">Keep comments</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button size="sm" variant="danger" disabled={isSending} onClick={handleClearAllComments}>
							Clear all comments
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
