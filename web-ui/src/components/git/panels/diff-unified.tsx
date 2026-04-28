import { useMemo } from "react";

import {
	buildDisplayItems,
	buildUnifiedDiffRows,
	CollapsedBlockControls,
	createHighlightedLineCache,
	DiffRowText,
	resolvePrismGrammar,
	resolvePrismLanguage,
	type UnifiedDiffRow,
	useIncrementalExpand,
} from "@/components/shared/diff-renderer";

import {
	commentKey,
	type DiffCommentCallbacks,
	type DiffLineComment,
	DiffLineGutter,
	InlineComment,
} from "./diff-viewer-utils";

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
	const highlightCache = useMemo(
		() => createHighlightedLineCache(prismGrammar, prismLanguage),
		[oldText, newText, prismGrammar, prismLanguage],
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
		const highlightedLineHtml = row.lineNumber == null || row.segments ? null : highlightCache.get(row.text);

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
					<DiffRowText row={row} highlightedLineHtml={highlightedLineHtml} highlightCache={highlightCache} />
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
