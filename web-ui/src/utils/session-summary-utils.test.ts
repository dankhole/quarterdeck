import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	mergeTaskSessionSummaryMap,
	reconcileAuthoritativeTaskSessionSummaryMap,
	selectNewestTaskSessionSummary,
} from "@/utils/session-summary-utils";

function createSessionSummary(taskId: string, updatedAt: number): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		sessionLaunchPath: "/tmp/project-a",
		pid: null,
		startedAt: updatedAt - 10,
		updatedAt,
		lastOutputAt: updatedAt,
		reviewReason: null,
		exitCode: null,
		lastHookAt: updatedAt,
		latestHookActivity: null,
		stalledSince: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	};
}

describe("selectNewestTaskSessionSummary", () => {
	it("returns the newer summary by updatedAt", () => {
		const older = createSessionSummary("task-1", 100);
		const newer = createSessionSummary("task-1", 200);

		expect(selectNewestTaskSessionSummary(older, newer)).toBe(newer);
		expect(selectNewestTaskSessionSummary(newer, older)).toBe(newer);
	});

	it("prefers the incoming summary when updatedAt ties", () => {
		const existing = createSessionSummary("task-1", 100);
		const incoming = {
			...createSessionSummary("task-1", 100),
			reviewReason: "hook" as const,
		};

		expect(selectNewestTaskSessionSummary(existing, incoming)).toBe(incoming);
	});
});

describe("mergeTaskSessionSummaryMap", () => {
	it("merges incoming summaries without dropping unrelated current tasks", () => {
		const current = {
			"task-1": createSessionSummary("task-1", 100),
			"task-2": createSessionSummary("task-2", 150),
		};

		const merged = mergeTaskSessionSummaryMap(current, [createSessionSummary("task-1", 200)]);

		expect(merged["task-1"]?.updatedAt).toBe(200);
		expect(merged["task-2"]?.updatedAt).toBe(150);
	});
});

describe("reconcileAuthoritativeTaskSessionSummaryMap", () => {
	it("drops tasks missing from the incoming authoritative session set", () => {
		const reconciled = reconcileAuthoritativeTaskSessionSummaryMap(
			{
				"task-1": createSessionSummary("task-1", 100),
				"task-2": createSessionSummary("task-2", 150),
			},
			{
				"task-1": createSessionSummary("task-1", 200),
			},
		);

		expect(reconciled).toEqual({
			"task-1": createSessionSummary("task-1", 200),
		});
	});

	it("still keeps the newer overlapping summary when the authoritative update is stale", () => {
		const current = createSessionSummary("task-1", 200);
		const incoming = createSessionSummary("task-1", 100);

		const reconciled = reconcileAuthoritativeTaskSessionSummaryMap({ "task-1": current }, { "task-1": incoming });

		expect(reconciled["task-1"]).toBe(current);
	});
});
