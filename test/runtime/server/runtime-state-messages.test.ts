import { describe, expect, it } from "vitest";

import type { RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "../../../src/core";
import {
	buildProjectStateUpdatedMessage,
	buildSnapshotMessage,
	buildTaskNotificationMessage,
	buildTaskSessionsUpdatedMessage,
	toBrowserProjectStateResponse,
	toBrowserSessionResponse,
} from "../../../src/server/runtime-state-messages";
import { createBoard } from "../../utilities/board-factory";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

function createSummaryWithReceipts(): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId: "task-1",
		lastProviderHookOccurredAt: 200,
		localForegroundInterrupt: {
			sessionInstanceId: "codex-process-1",
			provider: "codex",
			scopeId: "turn-1",
			occurredAt: 150,
			toolUseIds: ["tool"],
			awaitingNativeStart: true,
		},
		recentProviderHookDeliveryIds: ["00000000-0000-4000-8000-000000000001"],
		recentProviderHookOrderObservations: [
			{
				event: "to_review",
				deliveryId: "00000000-0000-4000-8000-000000000001",
				occurredAt: 200,
				source: "codex",
				sessionInstanceId: "codex-process-1",
				hookEventName: "Stop",
				notificationType: null,
				turnId: "turn-1",
				promptId: null,
				toolUseId: null,
				elicitationId: null,
				toolName: null,
			},
		],
	});
}

function createProjectState(summary: RuntimeTaskSessionSummary): RuntimeProjectStateResponse {
	return {
		repoPath: "/repo",
		statePath: "/state",
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		board: createBoard("Task"),
		sessions: { [summary.taskId]: summary },
		revision: 3,
	};
}

function expectStripped(summary: RuntimeTaskSessionSummary | undefined): void {
	expect(summary).not.toHaveProperty("localForegroundInterrupt");
	expect(summary).toMatchObject({
		taskId: "task-1",
		lastProviderHookOccurredAt: 200,
		recentProviderHookDeliveryIds: [],
		recentProviderHookOrderObservations: [],
	});
}

describe("browser-facing session summaries", () => {
	it("omits durable-only provider ordering receipts from every stream message carrying summaries", () => {
		const summary = createSummaryWithReceipts();
		const projectState = createProjectState(summary);

		const snapshot = buildSnapshotMessage("build", "project-1", [], projectState, { "project-1": [summary] });
		expectStripped(snapshot.projectState?.sessions["task-1"]);
		expectStripped(snapshot.notificationSummariesByProject?.["project-1"]?.[0]);
		expectStripped(buildProjectStateUpdatedMessage("project-1", projectState).projectState.sessions["task-1"]);
		expectStripped(buildTaskSessionsUpdatedMessage("project-1", [summary]).summaries[0]);
		expectStripped(buildTaskNotificationMessage("project-1", 1, [summary]).summaries[0]);
		expect(buildSnapshotMessage("build", null, [], null).projectState).toBeNull();
	});

	it("strips state and summary on browser-bound tRPC responses", () => {
		const summary = createSummaryWithReceipts();
		const response = toBrowserSessionResponse({ ok: true, state: createProjectState(summary), summary });
		expect(response.ok).toBe(true);
		expectStripped(response.state.sessions["task-1"]);
		expectStripped(response.summary);
		expect(toBrowserSessionResponse({ ok: false, summary: null })).toEqual({ ok: false, summary: null });
		expect(summary.recentProviderHookOrderObservations).toHaveLength(1);
	});

	it("omits the local negative boundary even when there are no provider receipts", () => {
		const summary = {
			...createSummaryWithReceipts(),
			recentProviderHookDeliveryIds: [],
			recentProviderHookOrderObservations: [],
		};
		expectStripped(toBrowserSessionResponse({ summary }).summary);
		expect(summary.localForegroundInterrupt?.scopeId).toBe("turn-1");
	});

	it("leaves the authoritative state untouched for persistence", () => {
		const summary = createSummaryWithReceipts();
		const projectState = createProjectState(summary);

		const browserState = toBrowserProjectStateResponse(projectState);
		expectStripped(browserState.sessions["task-1"]);
		expect(browserState.board).toBe(projectState.board);
		expect(browserState.revision).toBe(3);
		expect(projectState.sessions["task-1"]?.recentProviderHookOrderObservations).toHaveLength(1);
		expect(summary.recentProviderHookDeliveryIds).toHaveLength(1);
		expect(summary.localForegroundInterrupt?.scopeId).toBe("turn-1");
	});
});
