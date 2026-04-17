import { describe, expect, it } from "vitest";
import type { RuntimeWorkdirFileChange } from "@/runtime/types";
import {
	canPerformCommit,
	computeSelectedPaths,
	computeSelectionSync,
	formatCommitSuccessMessage,
} from "./commit-panel";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFile(path: string): RuntimeWorkdirFileChange {
	return { path, status: "modified", additions: 0, deletions: 0, oldText: null, newText: null };
}

// ---------------------------------------------------------------------------
// computeSelectionSync
// ---------------------------------------------------------------------------

describe("computeSelectionSync", () => {
	it("selects all files on first load (empty prevPaths)", () => {
		const files = [makeFile("a.ts"), makeFile("b.ts")];
		const result = computeSelectionSync(files, new Set(), new Map());
		expect(result.changed).toBe(true);
		expect(result.selection.get("a.ts")).toBe(true);
		expect(result.selection.get("b.ts")).toBe(true);
	});

	it("adds new files as checked", () => {
		const files = [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")];
		const prevPaths = new Set(["a.ts", "b.ts"]);
		const selection = new Map([
			["a.ts", true],
			["b.ts", false],
		]);
		const result = computeSelectionSync(files, prevPaths, selection);
		expect(result.changed).toBe(true);
		expect(result.selection.get("c.ts")).toBe(true);
		expect(result.selection.get("b.ts")).toBe(false); // preserved
	});

	it("removes departed files from selection", () => {
		const files = [makeFile("a.ts")];
		const prevPaths = new Set(["a.ts", "b.ts"]);
		const selection = new Map([
			["a.ts", true],
			["b.ts", true],
		]);
		const result = computeSelectionSync(files, prevPaths, selection);
		expect(result.changed).toBe(true);
		expect(result.selection.has("b.ts")).toBe(false);
	});

	it("returns unchanged when no files added or removed", () => {
		const files = [makeFile("a.ts")];
		const prevPaths = new Set(["a.ts"]);
		const selection = new Map([["a.ts", true]]);
		const result = computeSelectionSync(files, prevPaths, selection);
		expect(result.changed).toBe(false);
		expect(result.selection).toBe(selection); // same reference
	});
});

// ---------------------------------------------------------------------------
// computeSelectedPaths
// ---------------------------------------------------------------------------

describe("computeSelectedPaths", () => {
	it("returns checked file paths", () => {
		const files = [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")];
		const selection = new Map([
			["a.ts", true],
			["b.ts", false],
			["c.ts", true],
		]);
		expect(computeSelectedPaths(files, selection)).toEqual(["a.ts", "c.ts"]);
	});

	it("returns empty for null files", () => {
		expect(computeSelectedPaths(null, new Map())).toEqual([]);
	});

	it("returns empty when nothing selected", () => {
		const files = [makeFile("a.ts")];
		const selection = new Map([["a.ts", false]]);
		expect(computeSelectedPaths(files, selection)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// canPerformCommit
// ---------------------------------------------------------------------------

describe("canPerformCommit", () => {
	it("returns true when all conditions met", () => {
		expect(canPerformCommit(3, "fix bug", false)).toBe(true);
	});

	it("returns false when no files selected", () => {
		expect(canPerformCommit(0, "fix bug", false)).toBe(false);
	});

	it("returns false when message is empty", () => {
		expect(canPerformCommit(3, "", false)).toBe(false);
		expect(canPerformCommit(3, "   ", false)).toBe(false);
	});

	it("returns false when already committing", () => {
		expect(canPerformCommit(3, "fix bug", true)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// formatCommitSuccessMessage
// ---------------------------------------------------------------------------

describe("formatCommitSuccessMessage", () => {
	it("includes short hash when provided", () => {
		expect(formatCommitSuccessMessage("abc1234567890", false)).toBe("Committed (abc1234)");
	});

	it("includes 'and pushed' suffix when pushed", () => {
		expect(formatCommitSuccessMessage("abc1234567890", true)).toBe("Committed (abc1234) and pushed");
	});

	it("omits hash when null", () => {
		expect(formatCommitSuccessMessage(null, false)).toBe("Committed");
	});

	it("omits hash when undefined", () => {
		expect(formatCommitSuccessMessage(undefined, true)).toBe("Committed and pushed");
	});
});
