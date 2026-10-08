// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
	buildNoWorktreeAbortResponse,
	buildNoWorktreeContinueResponse,
	detectExternallyResolvedFiles,
	EMPTY_GIT_SYNC_SUMMARY,
} from "./conflict-resolution";

describe("detectExternallyResolvedFiles", () => {
	it("returns files that disappeared between polls", () => {
		const previous = ["src/a.ts", "src/b.ts", "src/c.ts"];
		const current = ["src/b.ts"];

		expect(detectExternallyResolvedFiles(previous, current)).toEqual(["src/a.ts", "src/c.ts"]);
	});

	it("returns empty when current set is same size or larger", () => {
		const previous = ["src/a.ts"];
		const current = ["src/a.ts", "src/b.ts"];

		expect(detectExternallyResolvedFiles(previous, current)).toEqual([]);
	});

	it("returns empty when previous is empty (initial state)", () => {
		expect(detectExternallyResolvedFiles([], ["src/a.ts"])).toEqual([]);
	});

	it("returns all files when current is empty", () => {
		const previous = ["src/a.ts", "src/b.ts"];

		expect(detectExternallyResolvedFiles(previous, [])).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

// ---------------------------------------------------------------------------
// Fallback responses
// ---------------------------------------------------------------------------

describe("buildNoWorktreeContinueResponse", () => {
	it("returns a failed response with empty summary", () => {
		const response = buildNoWorktreeContinueResponse();

		expect(response.ok).toBe(false);
		expect(response.completed).toBe(false);
		expect(response.output).toBe("");
		expect(response.summary).toEqual(EMPTY_GIT_SYNC_SUMMARY);
	});
});

describe("buildNoWorktreeAbortResponse", () => {
	it("returns a failed response with empty summary", () => {
		const response = buildNoWorktreeAbortResponse();

		expect(response.ok).toBe(false);
		expect(response.summary).toEqual(EMPTY_GIT_SYNC_SUMMARY);
	});
});
