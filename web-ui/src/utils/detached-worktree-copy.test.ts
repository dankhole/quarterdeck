import { describe, expect, it } from "vitest";

import { formatDetachedWorktreeLabel, getDetachedWorktreeTooltip } from "@/utils/detached-worktree-copy";

describe("detached worktree copy", () => {
	it("formats a compact detached label from the base ref", () => {
		expect(formatDetachedWorktreeLabel(" main ")).toBe("detached from main");
		expect(formatDetachedWorktreeLabel("")).toBeNull();
	});

	it("explains matching hashes as independent detached worktrees", () => {
		expect(getDetachedWorktreeTooltip({ baseRef: "main", headCommit: "deadbeef12345678" })).toBe(
			"HEAD is at deadbeef. This task has an independent detached worktree from main. Other tasks can show the same commit hash; changes here stay in this worktree.",
		);
	});

	it("omits the HEAD sentence when no commit-like value is available", () => {
		expect(getDetachedWorktreeTooltip({ baseRef: "main", headCommit: "initializing" })).toBe(
			"This task has an independent detached worktree from main. Other tasks can show the same commit hash; changes here stay in this worktree.",
		);
	});
});
