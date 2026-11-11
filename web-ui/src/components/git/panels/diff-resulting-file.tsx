import { Minus, Plus } from "lucide-react";
import { type MouseEvent, memo, useId, useMemo, useState } from "react";
import type { ReviewInteractions } from "@/components/editor/review-document-diff";
import { createSourceLineCache } from "@/components/editor/source-line-highlighting";
import { quarterdeckHighlightStyle } from "@/components/editor/source-presentation";
import { DeferredDiffRows } from "@/components/shared/deferred-diff-rows";
import { DiffRowText, type UnifiedDiffRow } from "@/components/shared/diff-renderer";
import { getDiffScrollLines } from "@/components/shared/diff-scroll-target";
import { DiffSymbolScope } from "@/components/shared/diff-symbol-highlighting";
import { cn } from "@/components/ui/cn";
import { useSourceLanguage } from "@/hooks/editor/use-source-language";
import { buildResultingFileItems, type ResultingFileChange } from "@/hooks/git/resulting-file-diff";
import { AgentDiffHunkAction } from "./agent-diff-hunk-action";
import {
	commentKey,
	createDiffAnchorLookup,
	type DiffAnchorLookup,
	DiffLineGutter,
	InlineComment,
	indexAnchoredComments,
} from "./diff-viewer-utils";

export interface ResultingFileDiffProps extends ReviewInteractions {
	path: string;
	oldText: string | null | undefined;
	newText: string;
	/** Empty content alone cannot distinguish an empty file from a deleted file. */
	isDeleted?: boolean;
}

export const ResultingFileDiff = memo(function ResultingFileDiff(props: ResultingFileDiffProps): React.ReactElement {
	const lookup = useMemo(
		() => props.anchorLookup ?? createDiffAnchorLookup(props.oldText, props.newText),
		[props.anchorLookup, props.oldText, props.newText],
	);
	// Retain unchanged source nodes and native focus/selection through content refreshes.
	return <ResultingFileSnapshot key={props.path} {...props} anchorLookup={lookup} />;
});

interface ResultingFileSnapshotProps extends ResultingFileDiffProps {
	anchorLookup: DiffAnchorLookup;
}

function ResultingFileSnapshot({
	path,
	oldText,
	newText,
	anchorLookup,
	comments,
	onAddComment,
	onUpdateComment,
	onDeleteComment,
	onSaveComment,
	onEditComment,
	onCancelEditComment,
	readOnlyReview = false,
	currentHunkRows,
	agentContextSource,
	isDeleted = false,
}: ResultingFileSnapshotProps): React.ReactElement {
	const lookup = anchorLookup;
	const { rows, revision } = lookup;
	const items = useMemo(() => buildResultingFileItems(rows), [rows]);
	const anchored = useMemo(() => indexAnchoredComments(path, comments, lookup), [path, comments, lookup]);
	const language = useSourceLanguage("", path);
	const highlightCache = useMemo(() => createSourceLineCache(path, language), [path, oldText, newText, language]);
	const [expansion, setExpansion] = useState<{ revision: string; blocks: ReadonlySet<string> }>(() => ({
		revision,
		blocks: new Set(),
	}));
	const expanded = expansion.revision === revision ? expansion.blocks : new Set<string>();
	if (expansion.revision !== revision) {
		// Reset only expansion before committing refreshed content; reusing a block
		// key must never open a different edit. Do not remount the source subtree.
		setExpansion({ revision, blocks: expanded });
	}
	const id = useId();
	const toggle = (key: string) =>
		setExpansion((previous) => {
			const next = new Set(previous.blocks);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return { revision, blocks: next };
		});
	const renderComment = (row: UnifiedDiffRow): React.ReactElement | null => {
		if (readOnlyReview || row.lineNumber == null) return null;
		const match = anchored.get(commentKey(path, row.lineNumber, row.variant));
		if (!match) return null;
		const { comment, draftKey } = match;
		return (
			<InlineComment
				comment={comment}
				onChange={(text) => onUpdateComment(path, row.lineNumber!, row.variant, text, draftKey)}
				onDelete={() => onDeleteComment(path, row.lineNumber!, row.variant, draftKey)}
				onSave={() => onSaveComment?.(path, row.lineNumber!, row.variant, draftKey)}
				onEdit={() => onEditComment?.(path, row.lineNumber!, row.variant, draftKey)}
				onCancel={() => onCancelEditComment?.(path, row.lineNumber!, row.variant, draftKey)}
			/>
		);
	};
	const renderMarker = (change: ResultingFileChange, disappearsOnClose = false): React.ReactElement => {
		const open = expanded.has(change.key);
		return (
			<button
				type="button"
				aria-label={`${open ? "Hide" : "Show"} ${change.kind} at ${path}:${change.current[0]?.lineNumber ?? change.removed[0]?.lineNumber}`}
				aria-expanded={open}
				data-resulting-marker={disappearsOnClose ? "removed" : "persistent"}
				data-current-difference={change.rows.some((row) => currentHunkRows?.has(row.key)) || undefined}
				aria-controls={`${id}-${change.key}`}
				className={cn(
					"w-4 shrink-0 self-stretch cursor-pointer border-l-3 focus-visible:outline-2 focus-visible:outline-accent",
					change.kind === "addition" && "border-status-green text-status-green",
					change.kind === "modification" && "border-status-blue text-status-blue",
					change.kind === "deletion" && "border-status-red text-status-red",
				)}
				onClick={(event) => {
					event.stopPropagation();
					if (
						open &&
						disappearsOnClose &&
						event.currentTarget.ownerDocument.activeElement === event.currentTarget
					) {
						// Move focus before this old-row button unmounts. Pointer activation
						// that did not focus the button must not steal focus from elsewhere.
						event.currentTarget
							.closest("[data-resulting-change]")
							?.querySelector<HTMLButtonElement>('button[data-resulting-marker="persistent"]')
							?.focus({ preventScroll: true });
					}
					toggle(change.key);
				}}
			>
				{open || change.kind === "deletion" ? (
					<Minus size={10} aria-hidden="true" />
				) : (
					<Plus size={10} aria-hidden="true" />
				)}
			</button>
		);
	};
	const renderRow = (row: UnifiedDiffRow, change?: ResultingFileChange, includeComment = true): React.ReactElement => {
		const hasComment =
			!readOnlyReview && row.lineNumber != null && anchored.has(commentKey(path, row.lineNumber, row.variant));
		const open = change != null && expanded.has(change.key);
		// Closed mode presents source syntax, without word-diff spans or full-row change backgrounds.
		const presentation = !open && row.variant !== "removed" && row.segments ? { ...row, segments: undefined } : row;
		const handleClick = (event: MouseEvent<HTMLDivElement>) => {
			if (
				!readOnlyReview &&
				!hasComment &&
				row.lineNumber != null &&
				event.target instanceof Element &&
				event.target.closest(".kb-diff-line-number")
			) {
				onAddComment(path, row.lineNumber, row.text, row.variant, revision);
			}
		};
		return (
			<div key={row.key}>
				<div
					className={cn(
						"kb-diff-row !grid-cols-[1rem_2rem_minmax(0,1fr)]",
						(!open || row.variant === "context") && "kb-diff-row-context",
						open && row.variant === "added" && "kb-diff-row-added",
						row.variant === "removed" && "kb-diff-row-removed",
						hasComment && "kb-diff-row-commented",
						readOnlyReview && "kb-diff-row-noncommentable",
					)}
					data-current-difference={currentHunkRows?.has(row.key) || undefined}
					data-diff-line={row.lineNumber ?? undefined}
					data-diff-side={row.variant === "removed" ? "removed" : "current"}
					data-code-navigation-side={row.variant === "removed" ? "old" : "new"}
					onClick={handleClick}
				>
					{change ? renderMarker(change, row.variant === "removed") : <span className="w-4 shrink-0" />}
					<DiffLineGutter
						lineNumber={row.lineNumber}
						canComment={!readOnlyReview}
						hasComment={hasComment}
						onDeleteComment={() =>
							onDeleteComment(
								path,
								row.lineNumber!,
								row.variant,
								anchored.get(commentKey(path, row.lineNumber!, row.variant))?.draftKey,
							)
						}
					/>
					<DiffRowText
						row={presentation}
						highlightedLineHtml={highlightCache.get(row.text)}
						highlightCache={highlightCache}
					/>
				</div>
				{includeComment ? renderComment(row) : null}
			</div>
		);
	};
	const renderChange = (change: ResultingFileChange): React.ReactElement => {
		const open = expanded.has(change.key);
		return (
			<div key={change.key} data-resulting-change={change.key}>
				{!open
					? change.removed.map((row) => (
							<span
								key={row.key}
								className="block h-0"
								aria-hidden="true"
								data-diff-line={row.lineNumber ?? undefined}
								data-diff-side="removed"
								data-current-difference={currentHunkRows?.has(row.key) || undefined}
							/>
						))
					: null}
				{change.current.length === 0 ? (
					<div
						className="flex min-h-5 items-stretch text-xs text-text-tertiary"
						data-current-difference={change.rows.some((row) => currentHunkRows?.has(row.key)) || undefined}
					>
						{renderMarker(change)}
						<span className="px-2">
							{change.removed.length} deleted {change.removed.length === 1 ? "line" : "lines"}
						</span>
					</div>
				) : null}
				<div id={`${id}-${change.key}`}>
					{open && !readOnlyReview ? (
						<AgentDiffHunkAction path={path} rows={change.rows} source={agentContextSource} />
					) : null}
					{open ? (
						<DeferredDiffRows
							rows={change.removed}
							getRowKey={(row) => row.key}
							getScrollLines={(row) => getDiffScrollLines(path, row)}
							renderRow={(row) => renderRow(row, change, false)}
						/>
					) : null}
					{change.removed.map((row) => (
						<div key={row.key}>{renderComment(row)}</div>
					))}
					<DeferredDiffRows
						rows={change.current}
						getRowKey={(row) => row.key}
						getScrollLines={(row) => getDiffScrollLines(path, row)}
						renderRow={(row) => renderRow(row, change)}
					/>
				</div>
			</div>
		);
	};
	return (
		<DiffSymbolScope identity={rows} path={path}>
			<style href="quarterdeck-editor-highlights" precedence="editor">
				{quarterdeckHighlightStyle.module?.getRules()}
			</style>
			{isDeleted ? (
				<div className="px-3 py-2 text-xs text-text-tertiary">Deleted file</div>
			) : rows.length === 0 ? (
				<div className="px-3 py-2 text-xs text-text-tertiary">Empty file</div>
			) : null}
			<DeferredDiffRows
				rows={items}
				getRowKey={(item) => item.key}
				getScrollLines={(item) =>
					(item.type === "context" ? [item.row] : item.rows).flatMap((row) => getDiffScrollLines(path, row))
				}
				renderRow={(item) => (item.type === "context" ? renderRow(item.row) : renderChange(item))}
			/>
		</DiffSymbolScope>
	);
}
