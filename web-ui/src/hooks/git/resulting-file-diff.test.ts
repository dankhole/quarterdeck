// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildUnifiedDiffRows } from "@/components/shared/diff-parser";
import { buildResultingFileItems } from "./resulting-file-diff";

describe("resulting-file projection", () => {
	it("retains the complete new file and the shared engine's line identities", () => {
		const rows = buildUnifiedDiffRows("before\nold\nafter\n", "before\nnew\nextra\nafter\n");
		const items = buildResultingFileItems(rows);
		expect(items.map((item) => item.type)).toEqual(["context", "change", "context"]);
		const change = items[1]!;
		if (change.type !== "change") throw new Error("Expected a change");
		expect(change.kind).toBe("modification");
		expect(change.removed.map((row) => row.lineNumber)).toEqual([2]);
		expect(change.current.map((row) => row.lineNumber)).toEqual([2, 3]);
		expect(change.current[0]).toBe(rows[2]);
		expect(
			items.flatMap((item) => (item.type === "context" ? [item.row.text] : item.current.map((row) => row.text))),
		).toEqual(["before", "new", "extra", "after"]);
	});

	it.each([
		[null, "added\n", "addition"],
		["deleted\n", "", "deletion"],
		["deleted\nkeep\n", "keep\n", "deletion"],
		["keep\ndeleted\n", "keep\n", "deletion"],
	] as const)("preserves %s → %s markers", (oldText, newText, kind) => {
		const rows = buildUnifiedDiffRows(oldText, newText);
		const changes = buildResultingFileItems(rows).filter((item) => item.type === "change");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.kind).toBe(kind);
		expect(changes[0]?.rows).toEqual(rows.filter((row) => row.variant !== "context"));
	});

	it("inherits the shared engine's CRLF and EOF-newline normalization", () => {
		const rows = buildUnifiedDiffRows("same\r\n", "same");
		expect(buildResultingFileItems(rows).every((item) => item.type === "context")).toBe(true);
		expect(rows.map((row) => row.text)).toEqual(["same"]);
	});

	it("does not collapse context or invent changes for unchanged and empty files", () => {
		const text = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
		expect(buildResultingFileItems(buildUnifiedDiffRows(text, text))).toHaveLength(100);
		expect(buildResultingFileItems(buildUnifiedDiffRows("", ""))).toEqual([]);
	});
});
