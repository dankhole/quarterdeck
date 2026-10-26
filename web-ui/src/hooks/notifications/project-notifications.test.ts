// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
	buildProjectNotificationProjection,
	createProjectTaskNotificationKey,
	flattenProjectNotificationTasks,
} from "@/hooks/notifications/project-notifications";
import {
	type RuntimeProjectNotificationStateMap,
	seedRuntimeProjectNotificationStateMapFromProjectState,
} from "@/runtime/runtime-notification-projects";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	createTestProjectStateResponse,
	createTestTaskHookActivity,
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "@/test-utils/task-session-factory";

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
					outstandingInteraction: createTestTaskOutstandingInteraction({ kind: "permission" }),
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
					outstandingInteraction: createTestTaskOutstandingInteraction({ kind: "permission" }),
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

	it.each([
		{
			name: "explicit error",
			summary: createSummary("shared", { state: "awaiting_review", reviewReason: "error" }),
			error: 1,
			needsInput: 0,
		},
		{
			name: "unknown interaction resolution without an error review reason",
			summary: createSummary("shared", {
				state: "awaiting_review",
				reviewReason: "hook",
				outstandingInteraction: createTestTaskOutstandingInteraction({ status: "resolution_unknown" }),
			}),
			error: 1,
			needsInput: 0,
		},
		{
			name: "waiting interaction overriding an error review reason",
			summary: createSummary("shared", {
				state: "awaiting_review",
				reviewReason: "error",
				outstandingInteraction: createTestTaskOutstandingInteraction(),
			}),
			error: 0,
			needsInput: 1,
		},
		{
			name: "ordinary review despite a failure notification on exit",
			summary: createSummary("shared", { state: "awaiting_review", reviewReason: "exit", exitCode: 1 }),
			error: 0,
			needsInput: 0,
		},
	])("derives exclusive counts from the shared classifier: $name", ({ summary, error, needsInput }) => {
		const projection = buildProjectNotificationProjection(
			{
				"project-a": { sessions: { shared: summary } },
				"project-b": { sessions: { shared: createSummary("shared", { state: "awaiting_review" }) } },
			},
			"project-b",
		);
		expect(projection.errorByProject).toEqual(error ? { "project-a": error } : {});
		expect(projection.needsInputByProject).toEqual(needsInput ? { "project-a": needsInput } : {});
		expect(projection.currentProjectHasNeedsInput).toBe(false);
		expect(projection.otherProjectsHaveNeedsInput).toBe(needsInput > 0);
	});

	it("uses actionable notification state without counting Trash, unstarted, or orphan errors", () => {
		const projectState = createTestProjectStateResponse();
		const review = projectState.board.columns.find((column) => column.id === "review")!;
		const trash = projectState.board.columns.find((column) => column.id === "trash")!;
		const card = (id: string) => ({ id, title: id, prompt: id, baseRef: "main", createdAt: 1, updatedAt: 1 });
		review.cards = [card("active"), { ...card("unstarted"), unstarted: true }];
		trash.cards = [card("trashed")];
		projectState.sessions = Object.fromEntries(
			["active", "unstarted", "trashed", "orphan"].map((taskId) => [
				taskId,
				createSummary(taskId, { state: "awaiting_review", reviewReason: "error" }),
			]),
		);
		const projects = seedRuntimeProjectNotificationStateMapFromProjectState({}, "project-a", projectState);
		expect(buildProjectNotificationProjection(projects, "project-a").errorByProject).toEqual({ "project-a": 1 });
	});

	it("flattens task ownership for notification hooks", () => {
		const flattened = flattenProjectNotificationTasks(createNotificationProjects());

		expect(flattened[createProjectTaskNotificationKey("project-a", "task-a-review")]?.projectId).toBe("project-a");
		expect(flattened[createProjectTaskNotificationKey("project-b", "task-b-review")]?.projectId).toBe("project-b");
		expect(flattened[createProjectTaskNotificationKey("project-b", "task-b-review")]?.summary.taskId).toBe(
			"task-b-review",
		);
	});

	it("keeps same-ID tasks from different projects as distinct notification identities", () => {
		const flattened = flattenProjectNotificationTasks({
			"project-a": { sessions: { shared: createSummary("shared", { state: "running" }) } },
			"project-b": { sessions: { shared: createSummary("shared", { state: "awaiting_review" }) } },
		});

		expect(Object.keys(flattened)).toHaveLength(2);
		expect(flattened[createProjectTaskNotificationKey("project-a", "shared")]?.summary.state).toBe("running");
		expect(flattened[createProjectTaskNotificationKey("project-b", "shared")]?.summary.state).toBe("awaiting_review");
	});

	it("counts a structured Claude attention wait as needs input", () => {
		const projection = buildProjectNotificationProjection(
			{
				"project-a": {
					sessions: {
						"task-question": createSummary("task-question", {
							state: "awaiting_review",
							reviewReason: "attention",
							outstandingInteraction: createTestTaskOutstandingInteraction(),
						}),
					},
				},
			},
			"project-a",
		);

		expect(projection.needsInputByProject).toEqual({ "project-a": 1 });
		expect(projection.currentProjectHasNeedsInput).toBe(true);
	});

	it("does not count an unproven legacy attention reason as needs input", () => {
		const projection = buildProjectNotificationProjection(
			{
				"project-a": {
					sessions: {
						"task-interrupted": createSummary("task-interrupted", {
							state: "awaiting_review",
							reviewReason: "attention",
						}),
					},
				},
			},
			"project-a",
		);

		expect(projection.needsInputByProject).toEqual({});
		expect(projection.currentProjectHasNeedsInput).toBe(false);
	});
});
