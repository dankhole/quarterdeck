import { useMemo } from "react";
import { DEFERRED_ROW_THRESHOLD, DeferredDiffChunk } from "./deferred-diff-rows";
import { buildContextDisplayItems } from "./diff-context";
import type { CollapsedContextBlock, ExpandedBlockState, UnifiedDiffRow } from "./diff-parser";

export function DiffContextRows({
	block,
	state,
	renderRow,
	renderControls,
}: {
	block: CollapsedContextBlock;
	state: ExpandedBlockState[string] | undefined;
	renderRow: (row: UnifiedDiffRow) => React.ReactElement;
	renderControls: (block: CollapsedContextBlock) => React.ReactElement;
}): React.ReactElement {
	const items = useMemo(() => buildContextDisplayItems(block, state), [block, state]);
	const visibleRowCount = items.reduce((count, item) => count + (item.type === "rows" ? item.rows.length : 0), 0);
	return (
		<>
			{items.map((item) =>
				item.type === "control" ? (
					<div key="control">{renderControls(item.block)}</div>
				) : (
					<DeferredDiffChunk
						key={item.key}
						rows={item.rows}
						renderRow={renderRow}
						defer={visibleRowCount > DEFERRED_ROW_THRESHOLD}
					/>
				),
			)}
		</>
	);
}
