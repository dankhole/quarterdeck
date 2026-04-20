import { describe, expect, it } from "vitest";
import { resolveBranchSelectorSections } from "@/hooks/git/branch-selector-popover";
import type { RuntimeGitRef } from "@/runtime/types";

function createRef(name: string, type: RuntimeGitRef["type"]): RuntimeGitRef {
	return {
		name,
		type,
		hash: `${name}-hash`,
		isHead: false,
	};
}

describe("resolveBranchSelectorSections", () => {
	it("splits local refs into pinned and unpinned sections", () => {
		const sections = resolveBranchSelectorSections(
			[createRef("main", "branch"), createRef("feature/worktree", "branch"), createRef("origin/main", "remote")],
			["feature/worktree"],
			"",
		);

		expect(sections.pinnedLocal.map((ref) => ref.name)).toEqual(["feature/worktree"]);
		expect(sections.unpinnedLocal.map((ref) => ref.name)).toEqual(["main"]);
		expect(sections.filteredRemote.map((ref) => ref.name)).toEqual(["origin/main"]);
	});

	it("returns the detached head row only when present and keeps fuzzy-filter matches", () => {
		const sections = resolveBranchSelectorSections(
			[
				createRef("HEAD~1", "detached"),
				createRef("release/test", "branch"),
				createRef("origin/release/test", "remote"),
			],
			[],
			"release",
		);

		expect(sections.detachedRef?.name).toBe("HEAD~1");
		expect(sections.unpinnedLocal.map((ref) => ref.name)).toEqual(["release/test"]);
		expect(sections.filteredRemote.map((ref) => ref.name)).toEqual(["origin/release/test"]);
	});
});
