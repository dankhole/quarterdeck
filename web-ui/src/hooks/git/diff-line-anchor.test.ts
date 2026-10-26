// @vitest-environment node

import { describe, expect, it } from "vitest";
import { relocateDiffLine } from "./diff-line-anchor";

describe("relocateDiffLine", () => {
	it("follows surviving lines past insertions above the anchor", () => {
		expect(relocateDiffLine("start\nanchor\nend", "intro\nstart\nextra\nanchor\nend", 2)).toBe(4);
	});

	it("follows surviving lines past deletions above the anchor", () => {
		expect(relocateDiffLine("intro\nstart\nextra\nanchor\nend", "start\nanchor\nend", 4)).toBe(2);
	});

	it("handles separate insertion and deletion regions in one update", () => {
		const previous = "head\nremove\nkeep\nanchor\ntail\nremove too";
		const next = "intro\nhead\nkeep\ninsert\nanchor\ntail\nnew tail";
		expect(relocateDiffLine(previous, next, 4)).toBe(5);
		expect(relocateDiffLine(previous, next, 5)).toBe(6);
	});

	it("prefers the following survivor when a deleted anchor is equally near both neighbors", () => {
		expect(relocateDiffLine("before\nanchor\nafter", "before\nreplacement\nafter", 2)).toBe(3);
	});

	it("chooses the nearest survivor by its source distance, not destination distance", () => {
		const previous = "before\nfirst deleted\nmiddle deleted\nlast deleted\nafter";
		const next = "before\ninsert one\ninsert two\ninsert three\nafter";
		expect(relocateDiffLine(previous, next, 2)).toBe(1);
		expect(relocateDiffLine(previous, next, 3)).toBe(5);
		expect(relocateDiffLine(previous, next, 4)).toBe(5);
	});

	it("uses the remaining neighbor when deletions reach a file edge", () => {
		expect(relocateDiffLine("deleted\nkeep\ntail", "keep\ntail", 1)).toBe(1);
		expect(relocateDiffLine("head\nkeep\ndeleted", "head\nkeep", 3)).toBe(2);
	});

	it("distinguishes repeated lines by their surrounding sequence", () => {
		const previous = "first\nrepeat\nfirst end\nsecond\nrepeat\nsecond end";
		const next = "intro\nfirst\nrepeat\nfirst end\nsecond\ninsert\nrepeat\nsecond end";
		expect(relocateDiffLine(previous, next, 2)).toBe(3);
		expect(relocateDiffLine(previous, next, 5)).toBe(7);
	});

	it("relocates only the surviving occurrence of repeated lines with fallback none", () => {
		const previous = "first\nrepeat\nfirst end\nsecond\nrepeat\nsecond end";
		const next = "intro\nfirst\nfirst end\nsecond\ninsert\nrepeat\nsecond end";
		expect(relocateDiffLine(previous, next, 2, "none")).toBeNull();
		expect(relocateDiffLine(previous, next, 5, "none")).toBe(6);
		expect(relocateDiffLine(previous, next, 2, "nearest")).toBe(3);
	});

	it.each([2, 3, 4])("does not substitute a neighbor for deleted line %s with fallback none", (lineNumber) => {
		const previous = "before\nfirst deleted\nmiddle deleted\nlast deleted\nafter";
		const next = "before\nreplacement\nafter";
		expect(relocateDiffLine(previous, next, lineNumber, "none")).toBeNull();
	});

	it("retains identical-text and normalized-line semantics with fallback none", () => {
		expect(relocateDiffLine("same\n\n", "same\n\n", 2, "none")).toBe(2);
		expect(relocateDiffLine("start\r\nanchor\r\n", "intro\nstart\nanchor", 2, "none")).toBe(3);
		expect(relocateDiffLine("", "", 1, "none")).toBeNull();
		expect(relocateDiffLine("same", "same", 2, "none")).toBeNull();
	});

	it("preserves blank lines in their surrounding sequence", () => {
		const previous = "first\n\nfirst end\nsecond\n\nsecond end\n";
		const next = "intro\nfirst\n\nfirst end\nsecond\ninsert\n\nsecond end\n";
		expect(relocateDiffLine(previous, next, 2)).toBe(3);
		expect(relocateDiffLine(previous, next, 5)).toBe(7);
	});

	it("returns the same line for identical text, including repeated and blank lines", () => {
		const text = "repeat\n\nrepeat\n";
		expect(relocateDiffLine(text, text, 1)).toBe(1);
		expect(relocateDiffLine(text, text, 2)).toBe(2);
		expect(relocateDiffLine(text, text, 3)).toBe(3);
		expect(relocateDiffLine(text, text, 4)).toBeNull();
	});

	it("normalizes CRLF and ignores an EOF newline like the unified parser", () => {
		expect(relocateDiffLine("start\r\nanchor\r\n", "intro\nstart\nanchor", 2)).toBe(3);
		expect(relocateDiffLine("start\nanchor", "start\r\nanchor\r\n", 2)).toBe(2);
		expect(relocateDiffLine("start\nanchor\n", "start\nanchor", 3)).toBeNull();
	});

	it("does not ignore meaningful whitespace or a lone carriage return", () => {
		expect(relocateDiffLine("before\n anchor\nafter", "before\nanchor\nafter", 2)).toBe(3);
		expect(relocateDiffLine("anchor\r", "anchor", 1)).toBeNull();
	});

	it("returns null for empty files and when no source lines survive", () => {
		expect(relocateDiffLine("", "", 1)).toBeNull();
		expect(relocateDiffLine("", "new", 1)).toBeNull();
		expect(relocateDiffLine("old", "", 1)).toBeNull();
		expect(relocateDiffLine("old\nlines", "all\nnew", 1)).toBeNull();
	});

	it("treats a newline-only file as one blank line, not an empty file", () => {
		expect(relocateDiffLine("\n", "\n", 1)).toBe(1);
		expect(relocateDiffLine("\n", "intro\n\n", 1)).toBe(2);
		expect(relocateDiffLine("\n", "", 1)).toBeNull();
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 3])("rejects invalid source line %s", (lineNumber) => {
		expect(relocateDiffLine("first\nsecond", "intro\nfirst\nsecond", lineNumber)).toBeNull();
		expect(relocateDiffLine("first\nsecond", "first\nsecond", lineNumber)).toBeNull();
	});
});
