import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	mergeTaskSessionSummaries,
	shouldApplyWorkspaceUpdate,
	shouldHydrateBoard,
	type WorkspaceVersion,
} from "./workspace-sync";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSession(taskId: string, startedAt: number | null, updatedAt: number): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: "claude",
		workspacePath: `/tmp/${taskId}`,
		pid: null,
		startedAt,
		updatedAt,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	};
}

// ---------------------------------------------------------------------------
// mergeTaskSessionSummaries
// ---------------------------------------------------------------------------

describe("mergeTaskSessionSummaries", () => {
	it("adds new sessions not present in current", () => {
		const current: Record<string, RuntimeTaskSessionSummary> = {};
		const next = { "task-1": makeSession("task-1", 100, 100) };

		const result = mergeTaskSessionSummaries(current, next);

		expect(result["task-1"]?.taskId).toBe("task-1");
	});

	it("keeps newer current session over older incoming one", () => {
		const current = { "task-1": makeSession("task-1", 200, 200) };
		const next = { "task-1": makeSession("task-1", 100, 100) };

		const result = mergeTaskSessionSummaries(current, next);

		expect(result["task-1"]?.startedAt).toBe(200);
	});

	it("replaces older current session with newer incoming one", () => {
		const current = { "task-1": makeSession("task-1", 100, 100) };
		const next = { "task-1": makeSession("task-1", 200, 200) };

		const result = mergeTaskSessionSummaries(current, next);

		expect(result["task-1"]?.startedAt).toBe(200);
	});

	it("preserves unrelated sessions in current", () => {
		const current = {
			"task-1": makeSession("task-1", 100, 100),
			"task-2": makeSession("task-2", 150, 150),
		};
		const next = { "task-1": makeSession("task-1", 200, 200) };

		const result = mergeTaskSessionSummaries(current, next);

		expect(result["task-2"]?.taskId).toBe("task-2");
		expect(result["task-1"]?.startedAt).toBe(200);
	});

	it("handles empty inputs", () => {
		expect(mergeTaskSessionSummaries({}, {})).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// shouldApplyWorkspaceUpdate
// ---------------------------------------------------------------------------

describe("shouldApplyWorkspaceUpdate", () => {
	it("returns 'apply' on first load (null revision)", () => {
		const version: WorkspaceVersion = { projectId: "proj-1", revision: null };

		expect(shouldApplyWorkspaceUpdate(version, "proj-1", 1)).toBe("apply");
	});

	it("returns 'apply' when incoming revision is newer", () => {
		const version: WorkspaceVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldApplyWorkspaceUpdate(version, "proj-1", 6)).toBe("apply");
	});

	it("returns 'apply' when incoming revision equals current", () => {
		const version: WorkspaceVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldApplyWorkspaceUpdate(version, "proj-1", 5)).toBe("apply");
	});

	it("returns 'skip' when incoming revision is older", () => {
		const version: WorkspaceVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldApplyWorkspaceUpdate(version, "proj-1", 3)).toBe("skip");
	});

	it("returns 'apply' when switching projects (different projectId)", () => {
		const version: WorkspaceVersion = { projectId: "proj-1", revision: 10 };

		expect(shouldApplyWorkspaceUpdate(version, "proj-2", 1)).toBe("apply");
	});
});

// ---------------------------------------------------------------------------
// shouldHydrateBoard
// ---------------------------------------------------------------------------

describe("shouldHydrateBoard", () => {
	it("returns true when switching projects", () => {
		const version: WorkspaceVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldHydrateBoard(version, "proj-2", 1)).toBe(true);
	});

	it("returns true when revision changes within same project", () => {
		const version: WorkspaceVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldHydrateBoard(version, "proj-1", 6)).toBe(true);
	});

	it("returns false when revision is unchanged within same project", () => {
		const version: WorkspaceVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldHydrateBoard(version, "proj-1", 5)).toBe(false);
	});

	it("returns true on first load (null revision)", () => {
		const version: WorkspaceVersion = { projectId: "proj-1", revision: null };

		expect(shouldHydrateBoard(version, "proj-1", 1)).toBe(true);
	});
});
