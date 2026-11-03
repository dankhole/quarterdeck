// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildUnifiedDiffRows } from "@/components/shared/diff-parser";
import { buildReviewHunks, focusedReviewScopeKey, reconcileReviewHunk, resolveReviewPath } from "./focused-review";
import type { ReviewScope } from "./review-document";

describe("focused review domain", () => {
	it("counts contiguous edits, not display groups, and combines replacements", () => {
		const hunks = buildReviewHunks(buildUnifiedDiffRows("old\nseparator\nlast\n", "new\nseparator\nfinal\n"));
		expect(hunks).toHaveLength(2);
		expect(hunks[0]?.rows.map((row) => row.variant)).toEqual(["removed", "added"]);
		expect(hunks[1]?.rows.map((row) => row.text)).toEqual(["last", "final"]);
	});
	it("anchors deletion-only EOF edits on the old side", () => {
		const hunks = buildReviewHunks(buildUnifiedDiffRows("keep\ndeleted", "keep\n"));
		expect(hunks).toHaveLength(1);
		expect(hunks[0]?.anchor).toEqual({ side: "removed", lineNumber: 2 });
		expect(buildReviewHunks(buildUnifiedDiffRows("", ""))).toEqual([]);
		expect(buildReviewHunks(buildUnifiedDiffRows("", "added"))[0]?.anchor).toEqual({
			side: "current",
			lineNumber: 1,
		});
	});
	it("preserves content identity through shifted lines and reconciles removed edits", () => {
		const oldHunks = buildReviewHunks(buildUnifiedDiffRows("a\nkeep\nz", "b\nkeep\ny"));
		const next = buildReviewHunks(buildUnifiedDiffRows("prefix\na\nkeep\nz", "prefix\nb\nkeep\ny"));
		expect(reconcileReviewHunk(next, 1, oldHunks[1]?.signature)).toBe(1);
		expect(next[1]?.anchor.lineNumber).toBe(4);
		expect(reconcileReviewHunk(next.slice(0, 1), 1, oldHunks[1]?.signature)).toBe(0);
		expect(reconcileReviewHunk([], 1)).toBe(-1);
		expect(resolveReviewPath(["a", "c"], "b", 1)).toBe("c");
		expect(resolveReviewPath(["a"], "c", 2)).toBe("a");
		expect(resolveReviewPath([], "c", 0)).toBeNull();
	});
	it("includes every repository/comparison identity but not refresh versions", () => {
		const scope: ReviewScope = {
			repository: { projectId: "p", taskId: "t", taskCreatedAt: 1, rootPath: "/repo" },
			revisions: { kind: "compare", base: "a", head: "b", headSource: "revision", mode: "two_dot" },
		};
		const key = focusedReviewScopeKey(scope);
		expect(focusedReviewScopeKey({ ...scope, revisions: { ...scope.revisions, version: 42 } })).toBe(key);
		for (const repository of [
			{ ...scope.repository, projectId: "p2" },
			{ ...scope.repository, taskCreatedAt: 2 },
			{ ...scope.repository, rootPath: "/other" },
			{ ...scope.repository, taskId: null },
		]) {
			expect(focusedReviewScopeKey({ ...scope, repository })).not.toBe(key);
		}
		for (const revisions of [
			{ ...scope.revisions, base: "c" },
			{ ...scope.revisions, head: "c" },
			{ ...scope.revisions, headSource: "live-worktree" as const },
			{ ...scope.revisions, mode: "three_dot" as const },
			{ ...scope.revisions, kind: "working-copy" as const },
		]) {
			expect(focusedReviewScopeKey({ ...scope, revisions })).not.toBe(key);
		}
	});
});
