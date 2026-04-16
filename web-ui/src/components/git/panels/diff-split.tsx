import { useMemo } from "react";

import {
	buildDisplayItems,
	buildUnifiedDiffRows,
	CollapsedBlockControls,
	DiffRowText,
	getHighlightedLineHtml,
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

interface SplitDiffRowPair {
	key: string;
	left: UnifiedDiffRow | null;
	right: UnifiedDiffRow | null;
}

function pairRowsForSplit(rows: UnifiedDiffRow[]): SplitDiffRowPair[] {
	const pairs: SplitDiffRowPair[] = [];
	let index = 0;
	while (index < rows.length) {
		const row = rows[index];
		if (!row) {
			index += 1;
			continue;
		}

		if (row.variant === "removed") {
			// Collect contiguous removed block
			const removedStart = index;
			while (index < rows.length && rows[index]!.variant === "removed") {
				index += 1;
			}
			const removedBlock = rows.slice(removedStart, index);

			// Collect contiguous added block immediately following
			const addedStart = index;
			while (index < rows.length && rows[index]!.variant === "added") {
				index += 1;
			}
			const addedBlock = rows.slice(addedStart, index);

			// Pair positionally
			const pairCount = Math.max(removedBlock.length, addedBlock.length);
			for (let pi = 0; pi < pairCount; pi += 1) {
				const left = removedBlock[pi] ?? null;
				const right = addedBlock[pi] ?? null;
				const key =
					left && right
						? `pair-${left.key}-${right.key}`
						: left
							? `pair-left-${left.key}`
							: `pair-right-${right!.key}`;
				pairs.push({ key, left, right });
			}
			continue;
		}

		if (row.variant === "added") {
			pairs.push({
				key: `pair-right-${row.key}`,
				left: null,
				right: row,
			});
			index += 1;
			continue;
		}

		pairs.push({
			key: `pair-context-${row.key}`,
			left: row,
			right: row,
		});
		index += 1;
	}

	return pairs;
}

function isCommentableOnSplitSide(row: UnifiedDiffRow, side: "left" | "right"): boolean {
	if (row.variant === "removed") {
		return side === "left";
	}
	if (row.variant === "added") {
		return side === "right";
	}
	return side === "right";
}

export function SplitDiff({
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
	const rows = useMemo(() => buildUnifiedDiffRows(oldText, newText), [oldText, newText]);
	const displayItems = useMemo(() => buildDisplayItems(rows, expandedBlocks), [expandedBlocks, rows]);

	const renderSide = (row: UnifiedDiffRow, side: "left" | "right"): React.ReactElement => {
		const rowLineNumber = row.lineNumber;
		if (rowLineNumber == null) {
			return <></>;
		}

		const canCommentOnSide = isCommentableOnSplitSide(row, side);
		const rowKey = canCommentOnSide ? commentKey(path, rowLineNumber, row.variant) : null;
		const existingComment = rowKey ? comments.get(rowKey) : null;
		const hasComment = existingComment != null;
		const baseClass =
			row.variant === "added"
				? "kb-diff-row kb-diff-row-added"
				: row.variant === "removed"
					? "kb-diff-row kb-diff-row-removed"
					: "kb-diff-row kb-diff-row-context";
		const rowClass = hasComment
			? `${baseClass} kb-diff-row-commented`
			: canCommentOnSide
				? baseClass
				: `${baseClass} kb-diff-row-noncommentable`;
		const canClickRow = canCommentOnSide && !hasComment;
		const highlightedLineHtml = getHighlightedLineHtml(row.text, prismGrammar, prismLanguage);

		return (
			<div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
				<div
					className={rowClass}
					style={canClickRow ? undefined : { cursor: "default" }}
					onClick={
						canClickRow
							? () => {
									onAddComment(rowLineNumber, row.text, row.variant);
								}
							: undefined
					}
				>
					<DiffLineGutter
						lineNumber={rowLineNumber}
						hasComment={hasComment}
						canComment={canCommentOnSide}
						onDeleteComment={hasComment ? () => onDeleteComment(rowLineNumber, row.variant) : undefined}
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
						onChange={(text) => onUpdateComment(rowLineNumber, row.variant, text)}
						onDelete={() => onDeleteComment(rowLineNumber, row.variant)}
					/>
				) : null}
			</div>
		);
	};

	const renderPairs = (sourceRows: UnifiedDiffRow[]): React.ReactElement[] => {
		const pairs = pairRowsForSplit(sourceRows);
		return pairs.map((pair) => (
			<div key={pair.key} className="kb-diff-split-grid-row">
				<div
					className={`kb-diff-split-cell ${pair.left ? "kb-diff-split-cell-filled" : "kb-diff-split-cell-placeholder"}`}
				>
					{pair.left ? renderSide(pair.left, "left") : null}
				</div>
				<div
					className={`kb-diff-split-cell kb-diff-split-cell-right ${pair.right ? "kb-diff-split-cell-filled" : "kb-diff-split-cell-placeholder"}`}
				>
					{pair.right ? renderSide(pair.right, "right") : null}
				</div>
			</div>
		));
	};

	const renderDisplayItems = (): React.ReactElement[] => {
		const renderedItems: React.ReactElement[] = [];
		let pendingRows: UnifiedDiffRow[] = [];

		const flushPendingRows = (): void => {
			if (pendingRows.length === 0) {
				return;
			}
			renderedItems.push(...renderPairs(pendingRows));
			pendingRows = [];
		};

		for (const item of displayItems) {
			if (item.type === "row") {
				pendingRows.push(item.row);
				continue;
			}

			flushPendingRows();
			renderedItems.push(
				<div key={item.block.id}>
					<div className="kb-diff-split-grid-row">
						<div className="kb-diff-split-cell kb-diff-split-cell-filled">
							<CollapsedBlockControls
								block={item.block}
								onExpandTop={expandTop}
								onExpandBottom={expandBottom}
								onExpandAll={expandAll}
							/>
						</div>
						<div className="kb-diff-split-cell kb-diff-split-cell-filled kb-diff-split-cell-right">
							<CollapsedBlockControls
								block={item.block}
								onExpandTop={expandTop}
								onExpandBottom={expandBottom}
								onExpandAll={expandAll}
							/>
						</div>
					</div>
					{item.block.expanded ? renderPairs(item.block.rows) : null}
				</div>,
			);
		}

		flushPendingRows();
		return renderedItems;
	};

	return (
		<div className="kb-diff-split-grid-shell">
			<div className="kb-diff-split-grid-backgrounds" aria-hidden>
				<div className="kb-diff-split-grid-background-column" />
				<div className="kb-diff-split-grid-background-column kb-diff-split-grid-background-column-right" />
			</div>
			<div className="kb-diff-split-grid-content">{renderDisplayItems()}</div>
		</div>
	);
}
