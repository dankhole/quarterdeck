import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { CollapsedContextBlock, ExpandedBlockState, UnifiedDiffRow } from "./diff-parser";
import { buildDisplayItems, INCREMENTAL_EXPAND_STEP, INCREMENTAL_EXPAND_THRESHOLD } from "./diff-parser";
import {
	createHighlightedLineCache,
	type HighlightedLineCache,
	resolvePrismGrammar,
	resolvePrismLanguage,
} from "./syntax-highlighting";

export type {
	CollapsedContextBlock,
	DiffDisplayItem,
	ExpandedBlockState,
	InlineDiffSegment,
	UnifiedDiffRow,
} from "./diff-parser";
export {
	buildDisplayItems,
	buildUnifiedDiffRows,
	CONTEXT_RADIUS,
	INCREMENTAL_EXPAND_STEP,
	INCREMENTAL_EXPAND_THRESHOLD,
	MIN_COLLAPSE_LINES,
	parsePatchToRows,
	truncatePathMiddle,
} from "./diff-parser";
// Re-export everything from sub-modules for backward compatibility.
export {
	createHighlightedLineCache,
	getHighlightedLineHtml,
	resolvePrismGrammar,
	resolvePrismLanguage,
	resolvePrismLanguageByAlias,
} from "./syntax-highlighting";

export function DiffRowText({
	row,
	highlightedLineHtml,
	highlightCache,
}: {
	row: UnifiedDiffRow;
	highlightedLineHtml: string | null;
	highlightCache: HighlightedLineCache | null;
}): React.ReactElement {
	if (!row.segments) {
		if (highlightedLineHtml) {
			return <span className="font-mono kb-diff-text" dangerouslySetInnerHTML={{ __html: highlightedLineHtml }} />;
		}
		return <span className="font-mono kb-diff-text">{row.text || " "}</span>;
	}

	return (
		<span className="font-mono kb-diff-text">
			{row.segments.map((segment) => {
				const className =
					segment.tone === "added"
						? "kb-diff-segment-added"
						: segment.tone === "removed"
							? "kb-diff-segment-removed"
							: undefined;
				const highlightedSegmentHtml = highlightCache?.get(segment.text) ?? null;
				if (highlightedSegmentHtml) {
					return (
						<span
							key={segment.key}
							className={className}
							dangerouslySetInnerHTML={{ __html: highlightedSegmentHtml }}
						/>
					);
				}
				return (
					<span key={segment.key} className={className}>
						{segment.text || " "}
					</span>
				);
			})}
		</span>
	);
}

export function CollapsedBlockControls({
	block,
	onExpandTop,
	onExpandBottom,
	onExpandAll,
}: {
	block: CollapsedContextBlock;
	onExpandTop: (id: string, count: number) => void;
	onExpandBottom: (id: string, count: number) => void;
	onExpandAll: (id: string) => void;
}): React.ReactElement {
	const count = block.count;

	if (block.expanded) {
		return (
			<Button
				variant="ghost"
				size="sm"
				fill
				icon={<ChevronDown size={12} />}
				className="justify-start text-xs rounded-none my-0.5 !bg-surface-0"
				onClick={() => onExpandAll(block.id)}
			>
				{`Hide ${count} unmodified lines`}
			</Button>
		);
	}

	if (count < INCREMENTAL_EXPAND_THRESHOLD) {
		return (
			<Button
				variant="ghost"
				size="sm"
				fill
				icon={<ChevronsUpDown size={12} />}
				className="justify-start text-xs rounded-none my-0.5 !bg-surface-0"
				onClick={() => onExpandAll(block.id)}
			>
				{`Show ${count} unmodified lines`}
			</Button>
		);
	}

	const step = INCREMENTAL_EXPAND_STEP;

	return (
		<div className="flex items-center gap-0.5 my-0.5">
			<Button
				variant="ghost"
				size="sm"
				icon={<ChevronDown size={12} />}
				className="justify-start text-xs rounded-none !bg-surface-0"
				onClick={() => onExpandTop(block.id, step)}
			>
				{`↓ ${step} lines`}
			</Button>
			<Button
				variant="ghost"
				size="sm"
				icon={<ChevronsUpDown size={12} />}
				className="justify-start text-xs rounded-none !bg-surface-0 flex-1"
				onClick={() => onExpandAll(block.id)}
			>
				{`Show all ${count} lines`}
			</Button>
			<Button
				variant="ghost"
				size="sm"
				icon={<ChevronUp size={12} />}
				className="justify-start text-xs rounded-none !bg-surface-0"
				onClick={() => onExpandBottom(block.id, step)}
			>
				{`↑ ${step} lines`}
			</Button>
		</div>
	);
}

export function useIncrementalExpand(): {
	expandedBlocks: ExpandedBlockState;
	expandTop: (id: string, count: number) => void;
	expandBottom: (id: string, count: number) => void;
	expandAll: (id: string) => void;
} {
	const [expandedBlocks, setExpandedBlocks] = useState<ExpandedBlockState>({});

	const expandTop = useCallback((id: string, count: number) => {
		setExpandedBlocks((prev) => {
			const current = prev[id];
			if (typeof current === "object" && current !== null) {
				return { ...prev, [id]: { top: current.top + count, bottom: current.bottom } };
			}
			return { ...prev, [id]: { top: count, bottom: 0 } };
		});
	}, []);

	const expandBottom = useCallback((id: string, count: number) => {
		setExpandedBlocks((prev) => {
			const current = prev[id];
			if (typeof current === "object" && current !== null) {
				return { ...prev, [id]: { top: current.top, bottom: current.bottom + count } };
			}
			return { ...prev, [id]: { top: 0, bottom: count } };
		});
	}, []);

	const expandAll = useCallback((id: string) => {
		setExpandedBlocks((prev) => {
			const current = prev[id];
			// If it's already fully expanded (true), toggle it off
			if (current === true) {
				const next = { ...prev };
				delete next[id];
				return next;
			}
			return { ...prev, [id]: true };
		});
	}, []);

	return { expandedBlocks, expandTop, expandBottom, expandAll };
}

export function ReadOnlyUnifiedDiff({ rows, path }: { rows: UnifiedDiffRow[]; path: string }): React.ReactElement {
	const { expandedBlocks, expandTop, expandBottom, expandAll } = useIncrementalExpand();
	const prismLanguage = useMemo(() => resolvePrismLanguage(path), [path]);
	const prismGrammar = useMemo(() => resolvePrismGrammar(prismLanguage), [prismLanguage]);
	const highlightCache = useMemo(
		() => createHighlightedLineCache(prismGrammar, prismLanguage),
		[prismGrammar, prismLanguage, rows],
	);
	const displayItems = useMemo(() => buildDisplayItems(rows, expandedBlocks), [expandedBlocks, rows]);

	const renderRow = (row: UnifiedDiffRow): React.ReactElement => {
		const baseClass =
			row.variant === "added"
				? "kb-diff-row kb-diff-row-added"
				: row.variant === "removed"
					? "kb-diff-row kb-diff-row-removed"
					: "kb-diff-row kb-diff-row-context";
		const highlightedLineHtml = highlightCache.get(row.text);

		return (
			<div key={row.key} className={baseClass} style={{ cursor: "default" }}>
				<span className="kb-diff-line-number" style={{ color: "var(--color-text-tertiary)" }}>
					<span className="kb-diff-line-number-text">{row.lineNumber ?? ""}</span>
				</span>
				<DiffRowText row={row} highlightedLineHtml={highlightedLineHtml} highlightCache={highlightCache} />
			</div>
		);
	};

	return (
		<div className="kb-diff-readonly">
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
		</div>
	);
}
