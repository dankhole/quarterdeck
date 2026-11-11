// @vitest-environment node

import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompareBar } from "./git-view-compare-bar";

const branchPicker = vi.hoisted(() => vi.fn());
vi.mock("@/components/git/panels/branch-selector-popover", () => ({
	BranchPillTrigger: () => null,
	BranchSelectorPopover: (props: unknown) => {
		branchPicker(props);
		return null;
	},
}));

describe("CompareBar branch grouping wiring", () => {
	beforeEach(() => branchPicker.mockClear());

	it.each([undefined, false, true])(
		"passes grouping %s to both pickers without losing selection or pin capabilities",
		(groupBranchesByFolder) => {
			const onSourceRefChange = vi.fn();
			const onTargetRefChange = vi.fn();
			const onTogglePinBranch = vi.fn();
			const branches = [{ name: "feature/nested/example", type: "branch" as const, hash: "abc123", isHead: false }];
			const worktreeBranches = new Map([["feature/busy", "/tmp/worktree"]]);
			const pinnedBranches = ["feature/pinned"];
			const props: ComponentProps<typeof CompareBar> = {
				sourceRef: "feature/source",
				targetRef: "feature/target",
				isBrowsing: false,
				hasOverride: false,
				branches,
				worktreeBranches,
				pinnedBranches,
				groupBranchesByFolder,
				onTogglePinBranch,
				includeUncommitted: false,
				threeDotDiff: false,
				onSourceRefChange,
				onTargetRefChange,
				onResetToDefaults: vi.fn(),
				onIncludeUncommittedChange: vi.fn(),
				onThreeDotDiffChange: vi.fn(),
			};
			renderToStaticMarkup(<CompareBar {...props} />);
			expect(branchPicker).toHaveBeenCalledTimes(2);
			for (const [picker] of branchPicker.mock.calls) {
				expect(picker).toMatchObject({
					groupBranchesByFolder: groupBranchesByFolder ?? false,
					branches,
					worktreeBranches,
					pinnedBranches,
					onTogglePinBranch,
					disableContextMenu: true,
				});
			}
			const source = branchPicker.mock.calls[0]?.[0] as {
				currentBranch: string;
				onSelectBranchView: (ref: string) => void;
			};
			const target = branchPicker.mock.calls[1]?.[0] as {
				currentBranch: string;
				onSelectBranchView: (ref: string) => void;
			};
			expect(source.currentBranch).toBe("feature/source");
			expect(target.currentBranch).toBe("feature/target");
			source.onSelectBranchView("origin/feature/nested/source");
			target.onSelectBranchView("upstream/feature/nested/target");
			expect(onSourceRefChange).toHaveBeenCalledWith("origin/feature/nested/source");
			expect(onTargetRefChange).toHaveBeenCalledWith("upstream/feature/nested/target");
		},
	);
});
