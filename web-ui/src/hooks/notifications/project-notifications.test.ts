import { describe, expect, it } from "vitest";
import {
	buildProjectNotificationProjection,
	flattenProjectNotificationTasks,
} from "@/hooks/notifications/project-notifications";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

function createSummary(taskId: string, overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: "claude",
		projectPath: "/tmp/repo",
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

function createNotificationProjects(): RuntimeProjectNotificationStateMap {
	return {
		"project-a": {
			sessions: {
				"task-a-review": createSummary("task-a-review", {
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						hookEventName: "PermissionRequest",
						notificationType: "permission.asked",
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						source: null,
						conversationSummaryText: null,
					},
				}),
				"task-a-running": createSummary("task-a-running", { state: "running" }),
			},
		},
		"project-b": {
			sessions: {
				"task-b-review": createSummary("task-b-review", {
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						hookEventName: null,
						notificationType: null,
						activityText: "Waiting for approval",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						source: null,
						conversationSummaryText: null,
					},
				}),
			},
		},
	};
}

describe("project-notifications", () => {
	it("builds per-project needs-input counts and current-project flags", () => {
		const projection = buildProjectNotificationProjection(createNotificationProjects(), "project-a");

		expect(projection.needsInputByProject).toEqual({
			"project-a": 1,
			"project-b": 1,
		});
		expect(projection.currentProjectHasNeedsInput).toBe(true);
		expect(projection.otherProjectsHaveNeedsInput).toBe(true);
	});

	it("flattens task ownership for notification hooks", () => {
		const flattened = flattenProjectNotificationTasks(createNotificationProjects());

		expect(flattened["task-a-review"]?.projectId).toBe("project-a");
		expect(flattened["task-b-review"]?.projectId).toBe("project-b");
		expect(flattened["task-b-review"]?.summary.taskId).toBe("task-b-review");
	});
});
