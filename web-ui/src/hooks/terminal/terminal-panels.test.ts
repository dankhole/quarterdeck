import { describe, expect, it } from "vitest";
import {
	collapseAllDetailPanels,
	computeTerminalPaneHeight,
	DEFAULT_DETAIL_TERMINAL_PANEL_STATE,
	EXPANDED_TERMINAL_PANE_HEIGHT,
	estimateShellTerminalCols,
	MIN_TERMINAL_COLS,
} from "./terminal-panels";

// ---------------------------------------------------------------------------
// estimateShellTerminalCols
// ---------------------------------------------------------------------------

describe("estimateShellTerminalCols", () => {
	it("returns at least MIN_TERMINAL_COLS", () => {
		const cols = estimateShellTerminalCols();
		expect(cols).toBeGreaterThanOrEqual(MIN_TERMINAL_COLS);
	});

	it("returns a positive integer", () => {
		const cols = estimateShellTerminalCols();
		expect(Number.isInteger(cols)).toBe(true);
		expect(cols).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// computeTerminalPaneHeight
// ---------------------------------------------------------------------------

describe("computeTerminalPaneHeight", () => {
	it("returns expanded sentinel when expanded", () => {
		expect(computeTerminalPaneHeight(true, 300)).toBe(EXPANDED_TERMINAL_PANE_HEIGHT);
	});

	it("returns persisted height when not expanded", () => {
		expect(computeTerminalPaneHeight(false, 400)).toBe(400);
	});

	it("returns undefined when not expanded and no persisted height", () => {
		expect(computeTerminalPaneHeight(false, undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// collapseAllDetailPanels
// ---------------------------------------------------------------------------

describe("collapseAllDetailPanels", () => {
	it("sets isExpanded to false for all entries", () => {
		const input = {
			"shell:t1": { isExpanded: true, isOpen: true },
			"shell:t2": { isExpanded: true, isOpen: false },
		};
		const result = collapseAllDetailPanels(input);
		expect(result["shell:t1"]).toEqual({ isExpanded: false, isOpen: true });
		expect(result["shell:t2"]).toEqual({ isExpanded: false, isOpen: false });
	});

	it("preserves already-collapsed entries", () => {
		const input = {
			"shell:t1": { isExpanded: false, isOpen: true },
		};
		const result = collapseAllDetailPanels(input);
		expect(result["shell:t1"]).toEqual({ isExpanded: false, isOpen: true });
	});

	it("returns empty object for empty input", () => {
		expect(collapseAllDetailPanels({})).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// DEFAULT_DETAIL_TERMINAL_PANEL_STATE
// ---------------------------------------------------------------------------

describe("DEFAULT_DETAIL_TERMINAL_PANEL_STATE", () => {
	it("has correct default values", () => {
		expect(DEFAULT_DETAIL_TERMINAL_PANEL_STATE).toEqual({
			isExpanded: false,
			isOpen: false,
		});
	});
});
