import { memo, useMemo } from "react";

import { DeferredDiffRows } from "@/components/shared/deferred-diff-rows";
import { DiffContextRows } from "@/components/shared/diff-context-rows";
import {
	buildDiffDisplayGroups,
	buildUnifiedDiffRows,
	CollapsedBlockControls,
	createHighlightedLineCache,
	DiffRowText,
	resolvePrismGrammar,
	resolvePrismLanguage,
	type UnifiedDiffRow,
	useIncrementalExpand,
} from "@/components/shared/diff-renderer";
import { AgentDiffHunkAction } from "./agent-diff-hunk-action";

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

export const SplitDiff = memo(function SplitDiff({
	path,
	agentContextSource,
	oldText,
	newText,
	comments,
	onAddComment,
	onUpdateComment,
	onDeleteComment,
}: {
	path: string;
	agentContextSource?: string;
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
	const displayItems = useMemo(
		() =>
			buildDiffDisplayGroups(rows).map((item) =>
				item.type === "rows" ? { ...item, pairs: pairRowsForSplit(item.rows) } : item,
			),
		[rows],
	);

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
		const highlightedLineHtml = row.segments ? null : highlightCache.get(row.text);

		return (
			<div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
				<div
					className={rowClass}
					style={canClickRow ? undefined : { cursor: "default" }}
					onClick={
						canClickRow
							? () => {
									onAddComment(path, rowLineNumber, row.text, row.variant);
								}
							: undefined
					}
				>
					<DiffLineGutter
						lineNumber={rowLineNumber}
						hasComment={hasComment}
						canComment={canCommentOnSide}
						onDeleteComment={hasComment ? () => onDeleteComment(path, rowLineNumber, row.variant) : undefined}
					/>
					<DiffRowText row={row} highlightedLineHtml={highlightedLineHtml} highlightCache={highlightCache} />
				</div>
				{existingComment ? (
					<InlineComment
						comment={existingComment}
						onChange={(text) => onUpdateComment(path, rowLineNumber, row.variant, text)}
						onDelete={() => onDeleteComment(path, rowLineNumber, row.variant)}
					/>
				) : null}
			</div>
		);
	};

	const renderPair = (pair: SplitDiffRowPair): React.ReactElement => (
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
	);

	return (
		<div className="kb-diff-split-grid-shell">
			<div className="kb-diff-split-grid-backgrounds" aria-hidden>
				<div className="kb-diff-split-grid-background-column" />
				<div className="kb-diff-split-grid-background-column kb-diff-split-grid-background-column-right" />
			</div>
			<div className="kb-diff-split-grid-content">
				{displayItems.map((item) =>
					item.type === "rows" ? (
						<div key={item.pairs[0]!.key}>
							<AgentDiffHunkAction path={path} rows={item.rows} source={agentContextSource} />
							<DeferredDiffRows rows={item.pairs} getRowKey={(pair) => pair.key} renderRow={renderPair} />
						</div>
					) : (
						<div key={item.block.id}>
							<DiffContextRows
								block={item.block}
								state={expandedBlocks[item.block.id]}
								renderRow={(row) => renderPair({ key: `pair-context-${row.key}`, left: row, right: row })}
								renderControls={(block) => (
									<div className="kb-diff-split-grid-row">
										{["left", "right"].map((side) => (
											<div
												key={side}
												className={`kb-diff-split-cell kb-diff-split-cell-filled ${side === "right" ? "kb-diff-split-cell-right" : ""}`}
											>
												<CollapsedBlockControls
													block={block}
													onExpandTop={expandTop}
													onExpandBottom={expandBottom}
													onExpandAll={expandAll}
												/>
											</div>
										))}
									</div>
								)}
							/>
						</div>
					),
				)}
			</div>
		</div>
	);
});
