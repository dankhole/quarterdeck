import {
	type CollapsedContextBlock,
	type ExpandedBlockState,
	INCREMENTAL_EXPAND_STEP,
	type UnifiedDiffRow,
} from "./diff-parser";

export type DiffContextDisplayItem =
	| { type: "rows"; key: string; rows: UnifiedDiffRow[] }
	| { type: "control"; block: CollapsedContextBlock };

/** Partition the original context, independently of which edges are revealed. */
export function buildContextDisplayItems(
	block: CollapsedContextBlock,
	state: ExpandedBlockState[string] | undefined,
): DiffContextDisplayItem[] {
	const count = block.rows.length;
	const expanded = state === true || (typeof state === "object" && state.expanded === true);
	const controlOffset = typeof state === "object" ? Math.min(state.top, count) : 0;
	const top = expanded ? count : controlOffset;
	const bottom = typeof state === "object" ? Math.min(state.bottom, count - top) : 0;
	const remaining = count - top - bottom;
	const boundaries = new Set([0, count]);
	// Both reveal directions end on these fixed boundaries. Keeping them even
	// after Show all avoids moving already-visible rows into another parent.
	for (let offset = INCREMENTAL_EXPAND_STEP; offset < count; offset += INCREMENTAL_EXPAND_STEP) {
		boundaries.add(offset);
		boundaries.add(count - offset);
	}
	const orderedBoundaries = [...boundaries].sort((a, b) => a - b);
	const items: DiffContextDisplayItem[] = [];
	let controlAdded = false;
	const addControl = () => {
		items.push({
			type: "control",
			block: { ...block, count: expanded ? count : remaining, expanded },
		});
		controlAdded = true;
	};
	for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
		const start = orderedBoundaries[index]!;
		const end = orderedBoundaries[index + 1]!;
		if (expanded && start === controlOffset) addControl();
		if (start >= top && end <= count - bottom) {
			if (remaining > 0 && !controlAdded) addControl();
			continue;
		}
		items.push({ type: "rows", key: block.rows[start]!.key, rows: block.rows.slice(start, end) });
	}
	if (expanded && !controlAdded) addControl();
	return items;
}
