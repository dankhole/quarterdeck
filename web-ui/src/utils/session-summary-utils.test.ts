import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { selectNewestTaskSessionSummary } from "@/utils/session-summary-utils";

function createSessionSummary(taskId: string, updatedAt: number): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		projectPath: "/tmp/project-a",
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
