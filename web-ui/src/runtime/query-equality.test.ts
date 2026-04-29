import { describe, expect, it } from "vitest";

import { areWorkdirChangesRevisionsEqual } from "@/runtime/query-equality";
import type { RuntimeWorkdirChangesResponse } from "@/runtime/types";

function createChanges(contentRevision: string | null = "rev-1", generatedAt = 1): RuntimeWorkdirChangesResponse {
	return {
		repoRoot: "/tmp/project",
		generatedAt,
		files: [
			{
				path: "src/a.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				oldText: null,
				newText: null,
				...(contentRevision === null ? {} : { contentRevision }),
			},
		],
	};
}

describe("areWorkdirChangesRevisionsEqual", () => {
	it("ignores generatedAt-only bumps", () => {
		expect(areWorkdirChangesRevisionsEqual(createChanges("rev-1", 1), createChanges("rev-1", 2))).toBe(true);
	});

	it("uses generatedAt as a fallback when content revisions are missing", () => {
		expect(areWorkdirChangesRevisionsEqual(createChanges(null, 1), createChanges(null, 2))).toBe(false);
	});

	it("detects per-file content revision changes", () => {
		expect(areWorkdirChangesRevisionsEqual(createChanges("rev-1", 1), createChanges("rev-2", 2))).toBe(false);
	});
});
