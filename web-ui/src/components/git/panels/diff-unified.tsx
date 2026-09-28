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

export const UnifiedDiff = memo(function UnifiedDiff({
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
	const displayItems = useMemo(() => buildDiffDisplayGroups(rows), [rows]);

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
						onAddComment(path, row.lineNumber!, row.text, row.variant);
					}
				: undefined;

		return (
			<div key={row.key}>
				<div className={rowClass} style={canClickRow ? undefined : { cursor: "default" }} onClick={handleRowClick}>
					<DiffLineGutter
						lineNumber={row.lineNumber}
						hasComment={hasComment}
						onDeleteComment={hasComment ? () => onDeleteComment(path, row.lineNumber!, row.variant) : undefined}
					/>
					<DiffRowText row={row} highlightedLineHtml={highlightedLineHtml} highlightCache={highlightCache} />
				</div>
				{existingComment ? (
					<InlineComment
						comment={existingComment}
						onChange={(text) => onUpdateComment(path, row.lineNumber!, row.variant, text)}
						onDelete={() => onDeleteComment(path, row.lineNumber!, row.variant)}
					/>
				) : null}
			</div>
		);
	};

	return (
		<>
			{displayItems.map((item) => {
				if (item.type === "rows") {
					return (
						<div key={item.rows[0]!.key}>
							<AgentDiffHunkAction path={path} rows={item.rows} source={agentContextSource} />
							<DeferredDiffRows rows={item.rows} getRowKey={(row) => row.key} renderRow={renderRow} />
						</div>
					);
				}

				return (
					<div key={item.block.id}>
						<DiffContextRows
							block={item.block}
							state={expandedBlocks[item.block.id]}
							renderRow={renderRow}
							renderControls={(block) => (
								<CollapsedBlockControls
									block={block}
									onExpandTop={expandTop}
									onExpandBottom={expandBottom}
									onExpandAll={expandAll}
								/>
							)}
						/>
					</div>
				);
			})}
		</>
	);
});
