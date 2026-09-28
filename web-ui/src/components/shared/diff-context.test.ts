import { describe, expect, it } from "vitest";
import { buildContextDisplayItems } from "./diff-context";
import type { CollapsedContextBlock, ExpandedBlockState } from "./diff-parser";

function contextBlock(count: number): CollapsedContextBlock {
	return {
		id: "context",
		count,
		expanded: false,
		rows: Array.from({ length: count }, (_, index) => ({
			key: `c-${index}`,
			lineNumber: index + 1,
			variant: "context",
			text: `line ${index + 1}`,
		})),
	};
}

describe("context display partitions", () => {
	it.each([8, 20, 21, 96, 317])("keeps exact row order and control counts for a %i-row block", (count) => {
		const block = contextBlock(count);
		const states: Array<ExpandedBlockState[string] | undefined> = [
			undefined,
			false,
			true,
			{ top: 20, bottom: 0 },
			{ top: 0, bottom: 20 },
			{ top: 40, bottom: 20 },
			{ top: 1_000, bottom: 20 },
			{ top: 20, bottom: 20, expanded: true },
		];
		for (const state of states) {
			const expanded = state === true || (typeof state === "object" && state.expanded);
			const top = expanded ? count : typeof state === "object" ? Math.min(state.top, count) : 0;
			const bottom = typeof state === "object" ? Math.min(state.bottom, count - top) : 0;
			const items = buildContextDisplayItems(block, state);
			const rows = items.flatMap((item) => (item.type === "rows" ? item.rows : []));
			expect(rows).toEqual([...block.rows.slice(0, top), ...block.rows.slice(count - bottom)]);
			const controls = items.filter((item) => item.type === "control");
			expect(controls).toHaveLength(expanded || count > top + bottom ? 1 : 0);
			if (controls[0]) expect(controls[0].block.count).toBe(expanded ? count : count - top - bottom);
		}
	});

	it("keeps partition keys and the control position after revealing both edges then Show all", () => {
		const block = contextBlock(317);
		const before = buildContextDisplayItems(block, { top: 80, bottom: 80 });
		const after = buildContextDisplayItems(block, { top: 80, bottom: 80, expanded: true });
		const beforeKeys = before.map((item) => (item.type === "rows" ? item.key : "control"));
		const afterKeys = after.map((item) => (item.type === "rows" ? item.key : "control"));
		expect(afterKeys.filter((key) => beforeKeys.includes(key))).toEqual(beforeKeys);
		for (const item of before) {
			if (item.type !== "rows") continue;
			expect(after.find((candidate) => candidate.type === "rows" && candidate.key === item.key)).toEqual(item);
		}
	});
});
