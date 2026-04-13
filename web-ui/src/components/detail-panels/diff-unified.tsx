import { useMemo } from "react";

import {
	buildDisplayItems,
	buildHighlightedLineMap,
	buildUnifiedDiffRows,
	CollapsedBlockControls,
	DiffRowText,
	resolvePrismGrammar,
	resolvePrismLanguage,
	type UnifiedDiffRow,
	useIncrementalExpand,
} from "@/components/shared/diff-renderer";

import { commentKey, type DiffLineComment, InlineComment } from "./diff-viewer-utils";

export interface DiffCommentCallbacks {
	onAddComment: (lineNumber: number, lineText: string, variant: "added" | "removed" | "context") => void;
	onUpdateComment: (lineNumber: number, variant: "added" | "removed" | "context", text: string) => void;
	onDeleteComment: (lineNumber: number, variant: "added" | "removed" | "context") => void;
}

export function UnifiedDiff({
	path,
	oldText,
	newText,
	comments,
	onAddComment,
	onUpdateComment,
	onDeleteComment,
}: {
	path: string;
	oldText: string | null | undefined;
	newText: string;
	comments: Map<string, DiffLineComment>;
} & DiffCommentCallbacks): React.ReactElement {
	const { expandedBlocks, expandTop, expandBottom, expandAll } = useIncrementalExpand();
	const prismLanguage = useMemo(() => resolvePrismLanguage(path), [path]);
	const prismGrammar = useMemo(() => resolvePrismGrammar(prismLanguage), [prismLanguage]);
	const highlightedOldByLine = useMemo(
		() => buildHighlightedLineMap(oldText, prismGrammar, prismLanguage),
		[oldText, prismGrammar, prismLanguage],
	);
	const highlightedNewByLine = useMemo(
		() => buildHighlightedLineMap(newText, prismGrammar, prismLanguage),
		[newText, prismGrammar, prismLanguage],
	);
	const rows = useMemo(() => buildUnifiedDiffRows(oldText, newText), [oldText, newText]);
	const displayItems = useMemo(() => buildDisplayItems(rows, expandedBlocks), [expandedBlocks, rows]);

	const renderRow = (row: UnifiedDiffRow): React.ReactElement => {
		const rowKey = row.lineNumber != null ? commentKey(path, row.lineNumber, row.variant) : null;
		const existingComment = rowKey ? comments.get(rowKey) : null;
		const hasComment = existingComment != null;
		const baseClass =
			row.variant === "added"
				? "kb-diff-row kb-diff-row-added"
				: row.variant === "removed"
					? "kb-diff-row kb-diff-row-removed"
					: "kb-diff-row kb-diff-row-context";
		const rowClass = hasComment ? `${baseClass} kb-diff-row-commented` : baseClass;
		const canClickRow = row.lineNumber != null && !hasComment;
		const highlightedLineHtml =
			row.lineNumber == null
				? null
				: row.variant === "removed"
					? (highlightedOldByLine.get(row.lineNumber) ?? null)
					: (highlightedNewByLine.get(row.lineNumber) ?? null);

		const handleRowClick =
			row.lineNumber != null && !hasComment
				? () => {
						onAddComment(row.lineNumber!, row.text, row.variant);
					}
				: undefined;

		return (
			<div key={row.key}>
				<div className={rowClass} style={canClickRow ? undefined : { cursor: "default" }} onClick={handleRowClick}>
					<DiffLineGutter
						lineNumber={row.lineNumber}
						hasComment={hasComment}
						onDeleteComment={hasComment ? () => onDeleteComment(row.lineNumber!, row.variant) : undefined}
					/>
					<DiffRowText
						row={row}
						highlightedLineHtml={highlightedLineHtml}
						grammar={prismGrammar}
						language={prismLanguage}
					/>
				</div>
				{existingComment ? (
					<InlineComment
						comment={existingComment}
						onChange={(text) => onUpdateComment(row.lineNumber!, row.variant, text)}
						onDelete={() => onDeleteComment(row.lineNumber!, row.variant)}
					/>
				) : null}
			</div>
		);
	};

	return (
		<>
			{displayItems.map((item) => {
				if (item.type === "row") {
					return renderRow(item.row);
				}

				return (
					<div key={item.block.id}>
						<CollapsedBlockControls
							block={item.block}
							onExpandTop={expandTop}
							onExpandBottom={expandBottom}
							onExpandAll={expandAll}
						/>
						{item.block.expanded ? item.block.rows.map((row) => renderRow(row)) : null}
					</div>
				);
			})}
		</>
	);
}

/* Shared gutter cell — used by both UnifiedDiff and SplitDiff */
import { MessageSquare, X } from "lucide-react";

export function DiffLineGutter({
	lineNumber,
	hasComment,
	canComment = true,
	onDeleteComment,
}: {
	lineNumber: number | null | undefined;
	hasComment: boolean;
	canComment?: boolean;
	onDeleteComment?: () => void;
}): React.ReactElement {
	return (
		<span className="kb-diff-line-number" style={{ color: "var(--color-text-tertiary)" }}>
			<span className="kb-diff-line-number-text">{lineNumber ?? ""}</span>
			{lineNumber != null && canComment ? (
				<span
					className="kb-diff-comment-gutter"
					onClick={
						hasComment
							? (event) => {
									event.stopPropagation();
									onDeleteComment?.();
								}
							: undefined
					}
					style={hasComment ? { cursor: "pointer" } : undefined}
				>
					<span className="kb-diff-gutter-icon-comment">
						<MessageSquare size={12} />
					</span>
					<span className="kb-diff-gutter-icon-delete">
						<X size={12} className="text-status-red" />
					</span>
				</span>
			) : null}
		</span>
	);
}
