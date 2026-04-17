import { describe, expect, it } from "vitest";
import {
	computeNextTaskGitActionLoading,
	deriveLoadingByTaskId,
	type GitActionErrorState,
	getGitActionErrorTitle,
	getGitSyncSuccessLabel,
	isTaskGitActionInFlight,
	matchesWorktreeInfoSelection,
	type TaskGitActionLoadingState,
} from "./git-actions";

// ---------------------------------------------------------------------------
// matchesWorktreeInfoSelection
// ---------------------------------------------------------------------------

describe("matchesWorktreeInfoSelection", () => {
	it("returns true when taskId and baseRef match", () => {
		const info = {
			taskId: "t1",
			baseRef: "main",
			path: "/tmp",
			exists: true,
			branch: "b",
			isDetached: false,
			headCommit: "abc",
		};
		const card = { id: "t1", baseRef: "main" } as Parameters<typeof matchesWorktreeInfoSelection>[1] & {};
		expect(matchesWorktreeInfoSelection(info, card)).toBe(true);
	});

	it("returns false when taskId differs", () => {
		const info = {
			taskId: "t1",
			baseRef: "main",
			path: "/tmp",
			exists: true,
			branch: "b",
			isDetached: false,
			headCommit: "abc",
		};
		const card = { id: "t2", baseRef: "main" } as Parameters<typeof matchesWorktreeInfoSelection>[1] & {};
		expect(matchesWorktreeInfoSelection(info, card)).toBe(false);
	});

	it("returns false when either argument is null", () => {
		expect(matchesWorktreeInfoSelection(null, null)).toBe(false);
		expect(matchesWorktreeInfoSelection(null, { id: "t1", baseRef: "main" } as never)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// deriveLoadingByTaskId
// ---------------------------------------------------------------------------

describe("deriveLoadingByTaskId", () => {
	const map: Record<string, TaskGitActionLoadingState> = {
		t1: { commitSource: "card", prSource: null },
		t2: { commitSource: "agent", prSource: "card" },
		t3: { commitSource: null, prSource: "agent" },
	};

	it("returns card commit tasks", () => {
		expect(deriveLoadingByTaskId(map, "commitSource", "card")).toEqual({ t1: true });
	});

	it("returns agent commit tasks", () => {
		expect(deriveLoadingByTaskId(map, "commitSource", "agent")).toEqual({ t2: true });
	});

	it("returns card PR tasks", () => {
		expect(deriveLoadingByTaskId(map, "prSource", "card")).toEqual({ t2: true });
	});

	it("returns agent PR tasks", () => {
		expect(deriveLoadingByTaskId(map, "prSource", "agent")).toEqual({ t3: true });
	});

	it("returns empty for no matches", () => {
		expect(deriveLoadingByTaskId({}, "commitSource", "card")).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// computeNextTaskGitActionLoading
// ---------------------------------------------------------------------------

describe("computeNextTaskGitActionLoading", () => {
	it("returns null when value unchanged", () => {
		const current = { t1: { commitSource: "card" as const, prSource: null } };
		expect(computeNextTaskGitActionLoading(current, "t1", "commitSource", "card")).toBeNull();
	});

	it("sets a new loading source", () => {
		const result = computeNextTaskGitActionLoading({}, "t1", "commitSource", "card");
		expect(result).toEqual({ t1: { commitSource: "card", prSource: null } });
	});

	it("removes entry when both sources become null", () => {
		const current = { t1: { commitSource: "card" as const, prSource: null } };
		const result = computeNextTaskGitActionLoading(current, "t1", "commitSource", null);
		expect(result).toEqual({});
		expect(result).not.toHaveProperty("t1");
	});

	it("preserves other task entries", () => {
		const current = {
			t1: { commitSource: "card" as const, prSource: null },
			t2: { commitSource: null, prSource: "agent" as const },
		};
		const result = computeNextTaskGitActionLoading(current, "t1", "commitSource", "agent");
		expect(result?.t1).toEqual({ commitSource: "agent", prSource: null });
		expect(result?.t2).toEqual({ commitSource: null, prSource: "agent" });
	});
});

// ---------------------------------------------------------------------------
// isTaskGitActionInFlight
// ---------------------------------------------------------------------------

describe("isTaskGitActionInFlight", () => {
	it("returns true when action is in flight", () => {
		const map = { t1: { commitSource: "card" as const, prSource: null } };
		expect(isTaskGitActionInFlight(map, "t1", "commitSource")).toBe(true);
	});

	it("returns false when action is null", () => {
		const map = { t1: { commitSource: null, prSource: null } };
		expect(isTaskGitActionInFlight(map, "t1", "commitSource")).toBe(false);
	});

	it("returns false for unknown task", () => {
		expect(isTaskGitActionInFlight({}, "unknown", "commitSource")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getGitActionErrorTitle
// ---------------------------------------------------------------------------

describe("getGitActionErrorTitle", () => {
	it("returns 'Git action failed' for null", () => {
		expect(getGitActionErrorTitle(null)).toBe("Git action failed");
	});

	it("returns action-specific titles", () => {
		const base: GitActionErrorState = { action: "fetch", message: "", output: "" };
		expect(getGitActionErrorTitle({ ...base, action: "fetch" })).toBe("Fetch failed");
		expect(getGitActionErrorTitle({ ...base, action: "pull" })).toBe("Pull failed");
		expect(getGitActionErrorTitle({ ...base, action: "push" })).toBe("Push failed");
	});
});

// ---------------------------------------------------------------------------
// getGitSyncSuccessLabel
// ---------------------------------------------------------------------------

describe("getGitSyncSuccessLabel", () => {
	it("returns correct labels", () => {
		expect(getGitSyncSuccessLabel("push")).toBe("Pushed");
		expect(getGitSyncSuccessLabel("pull")).toBe("Pulled");
		expect(getGitSyncSuccessLabel("fetch")).toBe("Fetched");
	});
});
