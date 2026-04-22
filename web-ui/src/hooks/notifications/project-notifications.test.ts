import { describe, expect, it } from "vitest";
import {
	buildProjectNotificationProjection,
	flattenProjectNotificationTasks,
} from "@/hooks/notifications/project-notifications";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestTaskHookActivity, createTestTaskSessionSummary } from "@/test-utils/task-session-factory";

function createSummary(taskId: string, overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		agentId: "claude",
		sessionLaunchPath: "/tmp/repo",
		updatedAt: Date.now(),
		...overrides,
	});
}

function createNotificationProjects(): RuntimeProjectNotificationStateMap {
	return {
		"project-a": {
			sessions: {
				"task-a-review": createSummary("task-a-review", {
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: createTestTaskHookActivity({
						hookEventName: "PermissionRequest",
						notificationType: "permission.asked",
					}),
				}),
				"task-a-running": createSummary("task-a-running", { state: "running" }),
			},
		},
		"project-b": {
			sessions: {
				"task-b-review": createSummary("task-b-review", {
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: createTestTaskHookActivity({
						activityText: "Waiting for approval",
					}),
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
