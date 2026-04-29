import { describe, expect, it } from "vitest";

import {
	resolveDetachedTaskWorktreeDisplay,
	resolveDetachedWorktreeDisplay,
	resolveTaskBaseRefDisplayState,
} from "@/utils/task-base-ref-display";

describe("task base-ref display state", () => {
	it("renders unresolved base refs as an explicit selection prompt", () => {
		const state = resolveTaskBaseRefDisplayState({ baseRef: "", baseRefPinned: true, behindBaseCount: 3 });

		expect(state.baseRefState.kind).toBe("unresolved");
		expect(state.triggerLabel).toBe("select base branch");
		expect(state.behindLabel).toBeNull();
		expect(state.pinToggleLabel).toBeNull();
	});

	it("renders inferred refs with branch-tracking copy", () => {
		const state = resolveTaskBaseRefDisplayState({ baseRef: " main ", behindBaseCount: 2 });

		expect(state.baseRefState.kind).toBe("inferred");
		expect(state.baseRefState.baseRef).toBe("main");
		expect(state.triggerLabel).toBe("from main");
		expect(state.behindLabel).toBe("2 behind");
		expect(state.pinToggleLabel).toBe("Unpinned - auto-updates on branch change");
	});

	it("renders pinned refs as locked user choices", () => {
		const state = resolveTaskBaseRefDisplayState({ baseRef: "develop", baseRefPinned: true });

		expect(state.baseRefState.kind).toBe("pinned");
		expect(state.baseRefState.tracksBranchChanges).toBe(false);
		expect(state.pinToggleLabel).toBe("Pinned - won't auto-update");
	});
});

describe("detached worktree display state", () => {
	it("uses the same base-ref normalization as base-ref labels", () => {
		expect(resolveDetachedWorktreeDisplay({ baseRef: " main ", headCommit: "deadbeef12345678" })).toEqual({
			baseRef: "main",
			headCommit: "deadbeef12345678",
			label: "detached from main",
			tooltip:
				"HEAD is at deadbeef. This task has an independent detached worktree from main. Other tasks can show the same commit hash; changes here stay in this worktree.",
		});
	});

	it("suppresses detached task copy for shared or unresolved tasks", () => {
		expect(
			resolveDetachedTaskWorktreeDisplay({
				isDetached: true,
				isAssignedShared: true,
				baseRef: "main",
				headCommit: "deadbeef",
			}),
		).toBeNull();
		expect(
			resolveDetachedTaskWorktreeDisplay({
				isDetached: true,
				isAssignedShared: false,
				baseRef: "",
				headCommit: "deadbeef",
			}),
		).toBeNull();
	});
});
