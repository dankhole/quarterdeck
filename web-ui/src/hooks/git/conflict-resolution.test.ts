import { describe, expect, it } from "vitest";
import {
	buildNoWorkspaceAbortResponse,
	buildNoWorkspaceContinueResponse,
	detectExternallyResolvedFiles,
	EMPTY_GIT_SYNC_SUMMARY,
	filterUnresolvedPaths,
	shouldResetOnStepChange,
} from "./conflict-resolution";

// ---------------------------------------------------------------------------
// shouldResetOnStepChange
// ---------------------------------------------------------------------------

describe("shouldResetOnStepChange", () => {
	it("returns true when both steps are non-null and differ", () => {
		expect(shouldResetOnStepChange(1, 2)).toBe(true);
	});

	it("returns false when steps are the same", () => {
		expect(shouldResetOnStepChange(2, 2)).toBe(false);
	});

	it("returns false when previous step is null (initial mount)", () => {
		expect(shouldResetOnStepChange(null, 1)).toBe(false);
	});

	it("returns false when current step is null (non-rebase operation)", () => {
		expect(shouldResetOnStepChange(1, null)).toBe(false);
	});

	it("returns false when both steps are null", () => {
		expect(shouldResetOnStepChange(null, null)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// filterUnresolvedPaths
// ---------------------------------------------------------------------------

describe("filterUnresolvedPaths", () => {
	it("returns all paths when none are resolved", () => {
		const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
		const resolved = new Set<string>();

		expect(filterUnresolvedPaths(paths, resolved)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
	});

	it("excludes resolved paths", () => {
		const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
		const resolved = new Set(["src/a.ts", "src/c.ts"]);

		expect(filterUnresolvedPaths(paths, resolved)).toEqual(["src/b.ts"]);
	});

	it("returns empty array when all paths are resolved", () => {
		const paths = ["src/a.ts"];
		const resolved = new Set(["src/a.ts"]);

		expect(filterUnresolvedPaths(paths, resolved)).toEqual([]);
	});

	it("returns empty array when no conflicted files", () => {
		expect(filterUnresolvedPaths([], new Set())).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// detectExternallyResolvedFiles
// ---------------------------------------------------------------------------

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

describe("buildNoWorkspaceContinueResponse", () => {
	it("returns a failed response with empty summary", () => {
		const response = buildNoWorkspaceContinueResponse();

		expect(response.ok).toBe(false);
		expect(response.completed).toBe(false);
		expect(response.output).toBe("");
		expect(response.summary).toEqual(EMPTY_GIT_SYNC_SUMMARY);
	});
});

describe("buildNoWorkspaceAbortResponse", () => {
	it("returns a failed response with empty summary", () => {
		const response = buildNoWorkspaceAbortResponse();

		expect(response.ok).toBe(false);
		expect(response.summary).toEqual(EMPTY_GIT_SYNC_SUMMARY);
	});
});
