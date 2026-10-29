import { memo, useMemo } from "react";
import { createSourceLineCache } from "@/components/editor/source-line-highlighting";
import { quarterdeckHighlightStyle } from "@/components/editor/source-presentation";
import { DeferredDiffRows } from "@/components/shared/deferred-diff-rows";
import { DiffContextRows } from "@/components/shared/diff-context-rows";
import {
	buildDiffDisplayGroups,
	CollapsedBlockControls,
	DiffRowText,
	type UnifiedDiffRow,
	useIncrementalExpand,
} from "@/components/shared/diff-renderer";
import { getDiffScrollLines } from "@/components/shared/diff-scroll-target";
import { useSourceLanguage } from "@/hooks/editor/use-source-language";
import { AgentDiffHunkAction } from "./agent-diff-hunk-action";

import {
	commentKey,
	createDiffAnchorLookup,
	type DiffCommentCallbacks,
	type DiffLineComment,
	DiffLineGutter,
	InlineComment,
	indexAnchoredComments,
} from "./diff-viewer-utils";

export const UnifiedDiff = memo(function UnifiedDiff({
	path,
	agentContextSource,
	oldText,
	newText,
	comments,
	anchorLookup,
	onAddComment,
	onUpdateComment,
	onDeleteComment,
	onSaveComment,
	onEditComment,
	onCancelEditComment,
	readOnlyReview = false,
}: {
	path: string;
	agentContextSource?: string;
	readOnlyReview?: boolean;
	oldText: string | null | undefined;
	newText: string;
	comments: Map<string, DiffLineComment>;
} & DiffCommentCallbacks): React.ReactElement {
	const { expandedBlocks, expandTop, expandBottom, expandAll } = useIncrementalExpand();
	const languageSupport = useSourceLanguage("", path);
	const highlightCache = useMemo(
		() => createSourceLineCache(path, languageSupport),
		[path, oldText, newText, languageSupport],
	);
	const lookup = useMemo(
		() => anchorLookup ?? createDiffAnchorLookup(oldText, newText),
		[anchorLookup, oldText, newText],
	);
	const { rows, revision: anchorRevision } = lookup;
	const anchoredComments = useMemo(() => indexAnchoredComments(path, comments, lookup), [path, comments, lookup]);
	const displayItems = useMemo(() => buildDiffDisplayGroups(rows), [rows]);

	const renderRow = (row: UnifiedDiffRow): React.ReactElement => {
		const rowKey = !readOnlyReview && row.lineNumber != null ? commentKey(path, row.lineNumber, row.variant) : null;
		const anchored = rowKey ? anchoredComments.get(rowKey) : undefined;
		const existingComment = anchored?.comment;
		const hasComment = existingComment != null;
		const baseClass =
			row.variant === "added"
				? "kb-diff-row kb-diff-row-added"
				: row.variant === "removed"
					? "kb-diff-row kb-diff-row-removed"
					: "kb-diff-row kb-diff-row-context";
		const rowClass = hasComment ? `${baseClass} kb-diff-row-commented` : baseClass;
		const canClickRow = !readOnlyReview && row.lineNumber != null && !hasComment;
		const highlightedLineHtml = row.lineNumber == null || row.segments ? null : highlightCache.get(row.text);

		const handleRowClick = canClickRow
			? () => {
					onAddComment(path, row.lineNumber!, row.text, row.variant, anchorRevision);
				}
			: undefined;

		return (
			<div key={row.key}>
				<div
					className={rowClass}
					data-diff-line={row.lineNumber ?? undefined}
					data-diff-side={row.variant === "removed" ? "removed" : "current"}
					data-code-navigation-side={row.variant === "removed" ? "old" : "new"}
					style={canClickRow ? undefined : { cursor: "default" }}
					onClick={handleRowClick}
				>
					<DiffLineGutter
						lineNumber={row.lineNumber}
						canComment={!readOnlyReview}
						hasComment={hasComment}
						onDeleteComment={
							hasComment
								? () => onDeleteComment(path, row.lineNumber!, row.variant, anchored?.draftKey)
								: undefined
						}
					/>
					<DiffRowText row={row} highlightedLineHtml={highlightedLineHtml} highlightCache={highlightCache} />
				</div>
				{existingComment ? (
					<InlineComment
						comment={existingComment}
						onChange={(text) => onUpdateComment(path, row.lineNumber!, row.variant, text, anchored?.draftKey)}
						onDelete={() => onDeleteComment(path, row.lineNumber!, row.variant, anchored?.draftKey)}
						onSave={() => onSaveComment?.(path, row.lineNumber!, row.variant, anchored?.draftKey)}
						onEdit={() => onEditComment?.(path, row.lineNumber!, row.variant, anchored?.draftKey)}
						onCancel={() => onCancelEditComment?.(path, row.lineNumber!, row.variant, anchored?.draftKey)}
					/>
				) : null}
			</div>
		);
	};

	return (
		<>
			<style href="quarterdeck-editor-highlights" precedence="editor">
				{quarterdeckHighlightStyle.module?.getRules()}
			</style>
			{displayItems.map((item) => {
				if (item.type === "rows") {
					return (
						<div key={item.rows[0]!.key}>
							{!readOnlyReview ? (
								<AgentDiffHunkAction path={path} rows={item.rows} source={agentContextSource} />
							) : null}
							<DeferredDiffRows
								rows={item.rows}
								getRowKey={(row) => row.key}
								getScrollLines={(row) => getDiffScrollLines(path, row)}
								renderRow={renderRow}
							/>
						</div>
					);
				}

				return (
					<div key={item.block.id}>
						<DiffContextRows
							block={item.block}
							state={
								!readOnlyReview &&
								item.block.rows.some(
									(row) =>
										row.lineNumber != null &&
										anchoredComments.has(commentKey(path, row.lineNumber, row.variant)),
								)
									? true
									: expandedBlocks[item.block.id]
							}
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
