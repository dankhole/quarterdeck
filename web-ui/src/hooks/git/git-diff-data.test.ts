import { describe, expect, it } from "vitest";

import { createCompareDiffViewKey, deriveDiffPriorityPaths, isGitDiffChangesPending } from "./git-diff-data";

describe("git diff data policy", () => {
	it("dedupes selected and visible paths while preserving foreground order", () => {
		expect(deriveDiffPriorityPaths("src/selected.ts", ["src/a.ts", "src/selected.ts", "src/b.ts"])).toEqual([
			"src/selected.ts",
			"src/a.ts",
			"src/b.ts",
		]);
	});

	it("keys compare views by refs, worktree inclusion, and diff mode", () => {
		expect(
			createCompareDiffViewKey({
				isCompareActive: true,
				sourceRef: "feature",
				targetRef: "main",
				includeUncommitted: false,
				diffMode: "three_dot",
			}),
		).toBe("compare:feature:main:refs:three_dot");
		expect(
			createCompareDiffViewKey({
				isCompareActive: true,
				sourceRef: "feature",
				targetRef: "main",
				includeUncommitted: true,
				diffMode: "two_dot",
			}),
		).toBe("compare:feature:main:wt:two_dot");
	});

	it("does not show compare loading while compare refs are incomplete", () => {
		expect(
			isGitDiffChangesPending({
				activeTab: "compare",
				hasCompareRefs: false,
				isRuntimeAvailable: true,
				activeFiles: null,
			}),
		).toBe(false);
		expect(
			isGitDiffChangesPending({
				activeTab: "uncommitted",
				hasCompareRefs: false,
				isRuntimeAvailable: true,
				activeFiles: null,
			}),
		).toBe(true);
	});
});
