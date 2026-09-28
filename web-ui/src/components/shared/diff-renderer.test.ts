import { describe, expect, it } from "vitest";
import {
	buildDiffDisplayGroups,
	CONTEXT_RADIUS,
	INCREMENTAL_EXPAND_STEP,
	INCREMENTAL_EXPAND_THRESHOLD,
	MIN_COLLAPSE_LINES,
	type UnifiedDiffRow,
} from "@/components/shared/diff-renderer";

function makeContextRows(count: number, startLine = 1): UnifiedDiffRow[] {
	const rows: UnifiedDiffRow[] = [];
	for (let i = 0; i < count; i += 1) {
		const lineNumber = startLine + i;
		rows.push({
			key: `c-${lineNumber}-${lineNumber}`,
			lineNumber,
			variant: "context",
			text: `line ${lineNumber}`,
		});
	}
	return rows;
}

function makeRowsWithChange(beforeCount: number, afterCount: number): UnifiedDiffRow[] {
	const rows: UnifiedDiffRow[] = [];
	let lineNumber = 1;
	for (let i = 0; i < beforeCount; i += 1) {
		rows.push({ key: `c-${lineNumber}-${lineNumber}`, lineNumber, variant: "context", text: `line ${lineNumber}` });
		lineNumber += 1;
	}
	rows.push({ key: `n-${lineNumber}`, lineNumber, variant: "added", text: `added line ${lineNumber}` });
	lineNumber += 1;
	for (let i = 0; i < afterCount; i += 1) {
		rows.push({ key: `c-${lineNumber}-${lineNumber}`, lineNumber, variant: "context", text: `line ${lineNumber}` });
		lineNumber += 1;
	}
	return rows;
}

describe("buildDiffDisplayGroups", () => {
	it("shows all rows when fewer than MIN_COLLAPSE_LINES context-only rows exist", () => {
		const rows = makeContextRows(MIN_COLLAPSE_LINES - 1);
		expect(buildDiffDisplayGroups(rows)).toEqual([{ type: "rows", rows }]);
	});

	it("collapses context-only rows when count >= MIN_COLLAPSE_LINES", () => {
		const rows = makeContextRows(MIN_COLLAPSE_LINES);
		expect(buildDiffDisplayGroups(rows)).toEqual([
			{
				type: "collapsed",
				block: { id: "ctx-0-7", count: MIN_COLLAPSE_LINES, rows, expanded: false },
			},
		]);
	});

	it("keeps the same context radius and block IDs around a change", () => {
		const rows = makeRowsWithChange(20, 20);
		expect(buildDiffDisplayGroups(rows)).toEqual([
			{ type: "collapsed", block: { id: "ctx-0-16", count: 17, rows: rows.slice(0, 17), expanded: false } },
			{ type: "rows", rows: rows.slice(17, 24) },
			{ type: "collapsed", block: { id: "ctx-24-40", count: 17, rows: rows.slice(24), expanded: false } },
		]);
	});

	it("keeps short distant context in the surrounding visible group", () => {
		const rows = makeRowsWithChange(CONTEXT_RADIUS + MIN_COLLAPSE_LINES - 1, 20);
		expect(buildDiffDisplayGroups(rows)).toEqual([
			{ type: "rows", rows: rows.slice(0, 14) },
			{ type: "collapsed", block: { id: "ctx-14-30", count: 17, rows: rows.slice(14), expanded: false } },
		]);
	});

	it("handles empty rows", () => {
		expect(buildDiffDisplayGroups([])).toEqual([]);
	});

	it("retains the context and incremental expansion constants", () => {
		expect(CONTEXT_RADIUS).toBe(3);
		expect(MIN_COLLAPSE_LINES).toBe(8);
		expect(INCREMENTAL_EXPAND_STEP).toBe(20);
		expect(INCREMENTAL_EXPAND_THRESHOLD).toBe(40);
	});
});
