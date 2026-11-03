import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ReviewDocumentDiff, type ReviewInteractions } from "@/components/editor/review-document-diff";
import { createDiffAnchorLookup, flattenFilePathsForDisplay } from "@/components/git/panels/diff-viewer-utils";
import { type DiffScrollLine, DiffScrollTargetContext } from "@/components/shared/diff-scroll-target";
import { buildReviewHunks, focusedReviewScopeKey } from "@/hooks/git/focused-review";
import { createReviewDocument, type ReviewContent } from "@/hooks/git/review-document";
import { useFocusedReview } from "@/hooks/git/use-focused-review";
import { createWorkdirSearchScope } from "@/hooks/search/search-scope";
import { isBinaryFilePath } from "@/utils/is-binary-file-path";
import type { DiffViewerPanelProps } from "./diff-viewer-panel";
import { FocusedReviewToolbar } from "./focused-review-toolbar";

const READ_ONLY_INTERACTIONS: ReviewInteractions = {
	readOnlyReview: true,
	comments: new Map(),
	onAddComment: () => {},
	onUpdateComment: () => {},
	onDeleteComment: () => {},
};

/** Owns one-file presentation and reveals deferred rows before a deliberate hunk jump. */
export function FocusedReviewPanel({
	projectFiles,
	reviewScope,
	selectedPath,
	onSelectedPathChange,
	onVisiblePathsChange,
	viewMode = "unified",
	fileLoadingState,
	codeNavigationConfig,
	navigateToFile,
}: DiffViewerPanelProps): React.ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const scrollTarget = useRef<DiffScrollLine | null>(null);
	const files = useMemo(() => new Map((projectFiles ?? []).map((file) => [file.path, file])), [projectFiles]);
	const paths = useMemo(() => flattenFilePathsForDisplay([...files.keys()]), [files]);
	const scopeKey = focusedReviewScopeKey(reviewScope);
	const getContent = useCallback(
		(path: string): ReviewContent => {
			const file = files.get(path);
			if (!file) return { kind: "unavailable" };
			if (isBinaryFilePath(path)) return { kind: "binary" };
			if (file.oldText != null || file.newText != null)
				return { kind: "text", oldText: file.oldText, newText: file.newText ?? "" };
			if (fileLoadingState?.errors?.has(path) || fileLoadingState?.loaded.has(path))
				return { kind: "unavailable", message: "Diff content is unavailable. Refresh to try again." };
			return { kind: "loading" };
		},
		[files, fileLoadingState],
	);
	const getHunks = useCallback(
		(path: string) => {
			const content = getContent(path);
			return content.kind === "loading" || content.kind === "unavailable"
				? null
				: content.kind === "text"
					? buildReviewHunks(createDiffAnchorLookup(content.oldText, content.newText).rows)
					: [];
		},
		[getContent],
	);
	const review = useFocusedReview({
		paths,
		selectedPath,
		onSelectedPathChange,
		scopeKey,
		getHunks,
		initialViewMode: viewMode,
	});
	const { path, hunk, hunkIndex, viewMode: layout } = review;
	const file = path === null ? null : files.get(path);
	const content = path === null ? null : getContent(path);
	const loadError = path === null ? undefined : fileLoadingState?.errors?.get(path);
	const currentHunkRows = useMemo(() => new Set(hunk?.rows.map((row) => row.key) ?? []), [hunk]);
	const anchorSide = hunk?.anchor.side;
	const anchorLine = hunk?.anchor.lineNumber;
	// DeferredDiffRows consumes the exact old/new-side target during commit.
	scrollTarget.current =
		path && anchorSide && anchorLine !== undefined ? { path, side: anchorSide, lineNumber: anchorLine } : null;

	useEffect(() => {
		onVisiblePathsChange?.(path === null ? [] : [path]);
	}, [path, onVisiblePathsChange]);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		if (anchorSide === undefined || anchorLine === undefined) {
			container.scrollTop = 0;
			return;
		}
		const reveal = () => {
			const row = container.querySelector<HTMLElement>(
				`[data-diff-side="${anchorSide}"][data-diff-line="${anchorLine}"]`,
			);
			if (!row) return false;
			container.scrollTop = Math.max(
				0,
				container.scrollTop +
					row.getBoundingClientRect().top -
					container.getBoundingClientRect().top -
					container.clientTop -
					16,
			);
			return true;
		};
		if (reveal()) return;
		const observer = new MutationObserver(() => {
			if (reveal()) observer.disconnect();
		});
		observer.observe(container, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [scopeKey, path, hunkIndex, anchorSide, anchorLine, layout]);

	return (
		<div
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0"
			data-focused-review
			onKeyDown={(event) => {
				if (
					event.defaultPrevented ||
					event.nativeEvent.isComposing ||
					!event.altKey ||
					event.ctrlKey ||
					event.metaKey ||
					event.shiftKey
				)
					return;
				if (
					event.target instanceof Element &&
					event.target.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")
				)
					return;
				const action =
					event.key === "ArrowLeft"
						? () => review.stepFile(-1)
						: event.key === "ArrowRight"
							? () => review.stepFile(1)
							: event.key === "ArrowUp"
								? () => review.stepHunk(-1)
								: event.key === "ArrowDown"
									? () => review.stepHunk(1)
									: null;
				if (action) {
					event.preventDefault();
					event.stopPropagation();
					action();
				}
			}}
		>
			<FocusedReviewToolbar
				path={path}
				fileIndex={review.fileIndex}
				fileCount={paths.length}
				hunkIndex={hunkIndex}
				hunkCount={review.hunks?.length ?? null}
				hunkStatus={content?.kind === "unavailable" ? "Differences unavailable" : undefined}
				viewMode={layout}
				onViewModeChange={review.setViewMode}
				onStepFile={review.stepFile}
				onStepHunk={review.stepHunk}
			/>
			<DiffScrollTargetContext.Provider value={scrollTarget}>
				<div
					ref={containerRef}
					role="region"
					aria-label="File diff"
					tabIndex={0}
					data-diff-scroll-container
					className="min-h-0 flex-1 overflow-auto overscroll-contain p-3"
				>
					{file && content ? (
						<section data-diff-path={path} aria-label={path ?? undefined}>
							{loadError ? (
								<p role="status" className="mb-2 text-xs text-status-orange">
									{content.kind === "text"
										? "Could not refresh diff. Showing previously loaded content."
										: "Could not load diff."}{" "}
									{loadError}
								</p>
							) : null}
							{content.kind === "text" && review.hunks?.length === 0 ? (
								<p className="mb-2 text-xs text-text-tertiary">No textual differences in this file.</p>
							) : null}
							<ReviewDocumentDiff
								document={createReviewDocument(reviewScope, file, content)}
								viewMode={layout}
								interactions={{ ...READ_ONLY_INTERACTIONS, currentHunkRows, fullContext: true }}
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
							/>
						</section>
					) : (
						<p role="status" className="py-8 text-center text-xs text-text-tertiary">
							{projectFiles === null ? "Loading changes…" : "No changes to display."}
						</p>
					)}
				</div>
			</DiffScrollTargetContext.Provider>
		</div>
	);
}
