import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	type CachedProjectBoardRestore,
	mergeTaskSessionSummaries,
	type ProjectVersion,
	resolveAuthoritativeBoardAction,
	shouldApplyProjectUpdate,
} from "./project-sync";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSession(taskId: string, startedAt: number | null, updatedAt: number): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: "claude",
		projectPath: `/tmp/${taskId}`,
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
// shouldApplyProjectUpdate
// ---------------------------------------------------------------------------

describe("shouldApplyProjectUpdate", () => {
	it("returns 'apply' on first load (null revision)", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: null };

		expect(shouldApplyProjectUpdate(version, "proj-1", 1)).toBe("apply");
	});

	it("returns 'apply' when incoming revision is newer", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldApplyProjectUpdate(version, "proj-1", 6)).toBe("apply");
	});

	it("returns 'apply' when incoming revision equals current", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldApplyProjectUpdate(version, "proj-1", 5)).toBe("apply");
	});

	it("returns 'skip' when incoming revision is older", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldApplyProjectUpdate(version, "proj-1", 3)).toBe("skip");
	});

	it("returns 'apply' when switching projects (different projectId)", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 10 };

		expect(shouldApplyProjectUpdate(version, "proj-2", 1)).toBe("apply");
	});
});

// ---------------------------------------------------------------------------
// resolveAuthoritativeBoardAction
// ---------------------------------------------------------------------------

describe("resolveAuthoritativeBoardAction", () => {
	it("hydrates when switching projects without a matching cache restore", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(resolveAuthoritativeBoardAction(version, "proj-2", 1, null)).toBe("hydrate");
	});

	it("hydrates when revision changes within the same project", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(resolveAuthoritativeBoardAction(version, "proj-1", 6, null)).toBe("hydrate");
	});

	it("skips hydration when the same authoritative revision is already applied", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(resolveAuthoritativeBoardAction(version, "proj-1", 5, null)).toBe("skip");
	});

	it("confirms a cached restore when the server sends the same revision", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: null };
		const cachedRestore: CachedProjectBoardRestore = {
			projectId: "proj-1",
			authoritativeRevision: 7,
		};

		expect(resolveAuthoritativeBoardAction(version, "proj-1", 7, cachedRestore)).toBe("confirm_cache");
	});

	it("hydrates on first load when there is no matching cached restore", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: null };

		expect(resolveAuthoritativeBoardAction(version, "proj-1", 1, null)).toBe("hydrate");
	});
});
