import { describe, expect, it } from "vitest";
import { deriveTaskIndicatorState } from "../../../src/core/api/task-indicators";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api/task-session";
import {
	deriveTaskNotificationState,
	getTaskNotificationSettleWindowMs,
	isNewTaskNotification,
	TASK_NOTIFICATION_EVENT_PRIORITY,
} from "../../../src/shared/task-notification-policy";
import {
	createTestTaskNativeWorkEvidence,
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

const deriveColumn = (summary: RuntimeTaskSessionSummary) => deriveTaskIndicatorState(summary).column;
const resolveSessionNotification = (summary: RuntimeTaskSessionSummary) =>
	deriveTaskIndicatorState(summary).notification;

function mockSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		agentId: "claude",
		sessionLaunchPath: "/tmp/repo",
		updatedAt: Date.now(),
		...overrides,
	});
}

function mockClaudeAttentionSummary(): RuntimeTaskSessionSummary {
	return mockSummary({
		state: "awaiting_review",
		reviewReason: "attention",
		outstandingInteraction: createTestTaskOutstandingInteraction(),
	});
}

describe("deriveColumn", () => {
	it("returns 'active' only for running state with current provider evidence", () => {
		expect(
			deriveColumn(
				mockSummary({
					state: "running",
					pid: 42,
					sessionInstanceId: "process-1",
					nativeWorkEvidence: createTestTaskNativeWorkEvidence({ provider: "claude" }),
				}),
			),
		).toBe("active");
	});

	it("returns 'stopped' for an unconfirmed native running claim", () => {
		expect(deriveColumn(mockSummary({ state: "running", pid: 42, sessionInstanceId: "process-1" }))).toBe("stopped");
	});

	it("returns 'silent' for awaiting_review with interrupted reason", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "interrupted" }))).toBe("silent");
	});

	it("returns 'stopped' for awaiting_review with hook reason", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "hook" }))).toBe("stopped");
	});

	it("returns 'stopped' for awaiting_review with error reason", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe("stopped");
	});

	it("returns 'stopped' for awaiting_review with exit reason", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "exit" }))).toBe("stopped");
	});

	it("returns 'stopped' for a structured Claude attention wait", () => {
		expect(deriveColumn(mockClaudeAttentionSummary())).toBe("stopped");
	});

	it("returns 'silent' for an unproven legacy attention reason", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "attention" }))).toBe("silent");
	});

	it("returns 'stopped' for error Review", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe("stopped");
	});
});

describe("resolveSessionNotification", () => {
	it("returns 'permission' for an exact durable approval interaction", () => {
		const result = resolveSessionNotification(
			mockSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				outstandingInteraction: createTestTaskOutstandingInteraction({ kind: "permission" }),
				latestHookActivity: {
					hookEventName: "PermissionRequest",
					notificationType: "permission.asked",
					activityText: null,
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					source: null,
				},
			}),
		);
		expect(result).toBe("permission");
	});

	it("does not sound an approval from presentation activity alone", () => {
		const result = resolveSessionNotification(
			mockSummary({
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
				},
			}),
		);
		expect(result).toBe("review");
	});

	it("returns 'review' for hook without approval activity", () => {
		const result = resolveSessionNotification(
			mockSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: {
					hookEventName: "SomeHook",
					notificationType: null,
					activityText: null,
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					source: null,
				},
			}),
		);
		expect(result).toBe("review");
	});

	it("returns 'review' for a structured Claude attention wait", () => {
		expect(resolveSessionNotification(mockClaudeAttentionSummary())).toBe("review");
	});

	it("returns null for an unproven legacy attention reason", () => {
		expect(
			resolveSessionNotification(mockSummary({ state: "awaiting_review", reviewReason: "attention" })),
		).toBeNull();
	});

	it("returns 'review' for exit with code 0", () => {
		expect(
			resolveSessionNotification(mockSummary({ state: "awaiting_review", reviewReason: "exit", exitCode: 0 })),
		).toBe("review");
	});

	it("returns 'failure' for exit with non-zero code", () => {
		expect(
			resolveSessionNotification(mockSummary({ state: "awaiting_review", reviewReason: "exit", exitCode: 1 })),
		).toBe("failure");
	});

	it("returns 'failure' for exit with null code", () => {
		expect(
			resolveSessionNotification(mockSummary({ state: "awaiting_review", reviewReason: "exit", exitCode: null })),
		).toBe("failure");
	});

	it("returns 'failure' for error reason", () => {
		expect(resolveSessionNotification(mockSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe(
			"failure",
		);
	});

	it("returns null for interrupted reason", () => {
		expect(
			resolveSessionNotification(mockSummary({ state: "awaiting_review", reviewReason: "interrupted" })),
		).toBeNull();
	});

	it("returns 'failure' for error Review", () => {
		expect(resolveSessionNotification(mockSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe(
			"failure",
		);
	});

	it("returns null for running state", () => {
		expect(resolveSessionNotification(mockSummary({ state: "running" }))).toBeNull();
	});
});

describe("getTaskNotificationSettleWindowMs", () => {
	it("returns hook settle window for hook-based review", () => {
		expect(
			getTaskNotificationSettleWindowMs(mockSummary({ state: "awaiting_review", reviewReason: "hook" })),
		).toBeGreaterThan(0);
	});

	it("returns immediate for non-hook review", () => {
		expect(getTaskNotificationSettleWindowMs(mockSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe(
			0,
		);
	});

	it("returns immediate for non-review state", () => {
		expect(getTaskNotificationSettleWindowMs(mockSummary({ state: "running" }))).toBe(0);
	});
});

describe("TASK_NOTIFICATION_EVENT_PRIORITY", () => {
	it("failure > permission > review", () => {
		expect(TASK_NOTIFICATION_EVENT_PRIORITY.failure).toBeGreaterThan(TASK_NOTIFICATION_EVENT_PRIORITY.permission);
		expect(TASK_NOTIFICATION_EVENT_PRIORITY.permission).toBeGreaterThan(TASK_NOTIFICATION_EVENT_PRIORITY.review);
	});
});

describe("isNewTaskNotification", () => {
	it("detects active-to-stopped notifications", () => {
		expect(
			isNewTaskNotification({ column: "active", eventType: null }, { column: "stopped", eventType: "review" }),
		).toBe(true);
	});

	it("detects a stronger notification while the task remains stopped", () => {
		expect(
			isNewTaskNotification(
				{ column: "stopped", eventType: "review" },
				{ column: "stopped", eventType: "permission" },
			),
		).toBe(true);
	});

	it("ignores unchanged and downgraded stopped notifications", () => {
		expect(
			isNewTaskNotification(
				{ column: "stopped", eventType: "permission" },
				{ column: "stopped", eventType: "permission" },
			),
		).toBe(false);
		expect(
			isNewTaskNotification(
				{ column: "stopped", eventType: "permission" },
				{ column: "stopped", eventType: "review" },
			),
		).toBe(false);
	});

	it("derives the semantic notification and column together", () => {
		expect(deriveTaskNotificationState(mockSummary({ state: "awaiting_review", reviewReason: "error" }))).toEqual({
			column: "stopped",
			eventType: "failure",
		});
	});
});
