import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	describeSessionState,
	getSessionStatusBadgeStyle,
	getSessionStatusTooltip,
	isApprovalState,
} from "./session-status";

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

describe("describeSessionState", () => {
	it("returns 'No session yet' for null", () => {
		expect(describeSessionState(null)).toBe("No session yet");
	});

	it("returns 'Running' for running state", () => {
		expect(describeSessionState(makeSummary({ state: "running" }))).toBe("Running");
	});

	it("returns 'Stalled' for awaiting_review with stalled reason", () => {
		expect(describeSessionState(makeSummary({ state: "awaiting_review", reviewReason: "stalled" }))).toBe("Stalled");
	});

	it("returns 'Completed' for awaiting_review with exit reason", () => {
		expect(describeSessionState(makeSummary({ state: "awaiting_review", reviewReason: "exit" }))).toBe("Completed");
	});

	it("returns 'Ready for review' for awaiting_review with hook reason (non-permission)", () => {
		expect(describeSessionState(makeSummary({ state: "awaiting_review", reviewReason: "hook" }))).toBe(
			"Ready for review",
		);
	});

	it("returns 'Waiting for approval' for permission request hook", () => {
		expect(
			describeSessionState(
				makeSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "permissionRequest",
						notificationType: null,
						source: null,
						conversationSummaryText: null,
					},
				}),
			),
		).toBe("Waiting for approval");
	});

	it("returns 'Waiting for input' for attention reason", () => {
		expect(describeSessionState(makeSummary({ state: "awaiting_review", reviewReason: "attention" }))).toBe(
			"Waiting for input",
		);
	});

	it("returns 'Error' for error reason", () => {
		expect(describeSessionState(makeSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe("Error");
	});

	it("returns 'Interrupted' for interrupted reason", () => {
		expect(describeSessionState(makeSummary({ state: "awaiting_review", reviewReason: "interrupted" }))).toBe(
			"Interrupted",
		);
	});

	it("returns 'Interrupted' for interrupted state", () => {
		expect(describeSessionState(makeSummary({ state: "interrupted" }))).toBe("Interrupted");
	});

	it("returns 'Failed' for failed state", () => {
		expect(describeSessionState(makeSummary({ state: "failed" }))).toBe("Failed");
	});

	it("returns 'Idle' for idle state", () => {
		expect(describeSessionState(makeSummary({ state: "idle" }))).toBe("Idle");
	});

	it("returns 'Ready for review' for unknown review reason in awaiting_review", () => {
		expect(describeSessionState(makeSummary({ state: "awaiting_review", reviewReason: null }))).toBe(
			"Ready for review",
		);
	});
});

describe("getSessionStatusBadgeStyle", () => {
	it("returns neutral for null", () => {
		expect(getSessionStatusBadgeStyle(null)).toBe("neutral");
	});

	it("returns running for running state", () => {
		expect(getSessionStatusBadgeStyle(makeSummary({ state: "running" }))).toBe("running");
	});

	it("returns review (green) for stalled review state", () => {
		expect(getSessionStatusBadgeStyle(makeSummary({ state: "awaiting_review", reviewReason: "stalled" }))).toBe(
			"review",
		);
	});

	it("returns review for awaiting_review with exit reason", () => {
		expect(getSessionStatusBadgeStyle(makeSummary({ state: "awaiting_review", reviewReason: "exit" }))).toBe(
			"review",
		);
	});

	it("returns error for awaiting_review with error reason", () => {
		expect(getSessionStatusBadgeStyle(makeSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe(
			"error",
		);
	});

	it("returns neutral for awaiting_review with interrupted reason", () => {
		expect(getSessionStatusBadgeStyle(makeSummary({ state: "awaiting_review", reviewReason: "interrupted" }))).toBe(
			"neutral",
		);
	});

	it("returns needs_input for permission request hook", () => {
		expect(
			getSessionStatusBadgeStyle(
				makeSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "permissionRequest",
						notificationType: null,
						source: null,
						conversationSummaryText: null,
					},
				}),
			),
		).toBe("needs_input");
	});

	it("returns review for non-permission hook", () => {
		expect(getSessionStatusBadgeStyle(makeSummary({ state: "awaiting_review", reviewReason: "hook" }))).toBe(
			"review",
		);
	});

	it("returns error for interrupted state", () => {
		expect(getSessionStatusBadgeStyle(makeSummary({ state: "interrupted" }))).toBe("error");
	});

	it("returns error for failed state", () => {
		expect(getSessionStatusBadgeStyle(makeSummary({ state: "failed" }))).toBe("error");
	});

	it("returns neutral for idle state", () => {
		expect(getSessionStatusBadgeStyle(makeSummary({ state: "idle" }))).toBe("neutral");
	});
});

describe("getSessionStatusTooltip", () => {
	it("returns null for null summary", () => {
		expect(getSessionStatusTooltip(null)).toBeNull();
	});

	it("returns null for normal running state", () => {
		expect(getSessionStatusTooltip(makeSummary({ state: "running" }))).toBeNull();
	});

	it("returns explanatory text for stalled review state", () => {
		const tooltip = getSessionStatusTooltip(makeSummary({ state: "awaiting_review", reviewReason: "stalled" }));
		expect(tooltip).toContain("stalled");
		expect(tooltip).toContain("thinking");
	});

	it("returns null for non-stalled review states", () => {
		expect(getSessionStatusTooltip(makeSummary({ state: "awaiting_review", reviewReason: "hook" }))).toBeNull();
	});
});

describe("isApprovalState", () => {
	it("returns false for null", () => {
		expect(isApprovalState(null)).toBe(false);
	});

	it("returns false for running state", () => {
		expect(isApprovalState(makeSummary({ state: "running" }))).toBe(false);
	});

	it("returns false for awaiting_review without hook reason", () => {
		expect(isApprovalState(makeSummary({ state: "awaiting_review", reviewReason: "exit" }))).toBe(false);
	});

	it("returns false for hook reason without permission activity", () => {
		expect(isApprovalState(makeSummary({ state: "awaiting_review", reviewReason: "hook" }))).toBe(false);
	});

	it("returns true for hook + permissionRequest hookEventName", () => {
		expect(
			isApprovalState(
				makeSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "permissionRequest",
						notificationType: null,
						source: null,
						conversationSummaryText: null,
					},
				}),
			),
		).toBe(true);
	});

	it("returns true for hook + permission_prompt notificationType", () => {
		expect(
			isApprovalState(
				makeSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: null,
						notificationType: "permission_prompt",
						source: null,
						conversationSummaryText: null,
					},
				}),
			),
		).toBe(true);
	});

	it("returns true for hook + permission.asked notificationType", () => {
		expect(
			isApprovalState(
				makeSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: null,
						notificationType: "permission.asked",
						source: null,
						conversationSummaryText: null,
					},
				}),
			),
		).toBe(true);
	});

	it("returns true for hook + 'waiting for approval' activityText", () => {
		expect(
			isApprovalState(
				makeSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						activityText: "Waiting for approval",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: null,
						notificationType: null,
						source: null,
						conversationSummaryText: null,
					},
				}),
			),
		).toBe(true);
	});
});
