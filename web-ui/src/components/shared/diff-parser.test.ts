// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildDiffDisplayGroups, buildUnifiedDiffRows, parsePatchToRows } from "./diff-parser";

describe("inline diff work budget", () => {
	it("keeps exact rows when extensive word changes exceed the optional highlighting budget", () => {
		const oldText = Array.from({ length: 400 }, (_, index) => `before${index}`).join(" ");
		const newText = Array.from({ length: 400 }, (_, index) => `after${index}`).join(" ");
		for (const rows of [
			buildUnifiedDiffRows(oldText, newText),
			parsePatchToRows(`@@ -1 +1 @@\n-${oldText}\n+${newText}\n`),
		]) {
			expect(rows.map(({ variant, lineNumber, text }) => ({ variant, lineNumber, text }))).toEqual([
				{ variant: "removed", lineNumber: 1, text: oldText },
				{ variant: "added", lineNumber: 1, text: newText },
			]);
			expect(rows[0]?.segments).toEqual([{ key: "o-line", text: oldText, tone: "removed" }]);
			expect(rows[1]?.segments).toEqual([{ key: "n-line", text: newText, tone: "added" }]);
		}
	});

	it("retains focused word highlighting for ordinary edits", () => {
		const rows = buildUnifiedDiffRows("const value = before;", "const value = after;");
		expect(rows[0]?.segments?.filter((segment) => segment.tone === "removed").map((segment) => segment.text)).toEqual(
			["before"],
		);
		expect(rows[1]?.segments?.filter((segment) => segment.tone === "added").map((segment) => segment.text)).toEqual([
			"after",
		]);
	});

	it("preserves very long generated lines without word tokenization", () => {
		const oldText = `before ${"x".repeat(25_000)}`;
		const newText = `after ${"x".repeat(25_000)}`;
		const rows = buildUnifiedDiffRows(oldText, newText);
		expect(rows[0]?.segments).toHaveLength(1);
		expect(rows[1]?.segments).toHaveLength(1);
		expect(rows.map((row) => row.segments?.map((segment) => segment.text).join(""))).toEqual([oldText, newText]);
	});
});

describe("buildDiffDisplayGroups", () => {
	it("keeps visible and collapsed rows in source order without copying row identities", () => {
		const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
		const rows = buildUnifiedDiffRows(before, `${before}\nadded`);
		const groups = buildDiffDisplayGroups(rows);
		expect(groups).toEqual([
			{ type: "collapsed", block: { id: "ctx-0-26", count: 27, rows: rows.slice(0, 27), expanded: false } },
			{ type: "rows", rows: rows.slice(27) },
		]);
		const groupedRows = groups.flatMap((group) => (group.type === "rows" ? group.rows : group.block.rows));
		expect(groupedRows).toHaveLength(rows.length);
		groupedRows.forEach((row, index) => {
			expect(row).toBe(rows[index]);
		});
	});
});
