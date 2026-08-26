import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestTaskOutstandingInteraction, createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import {
	describeSessionState,
	getSessionStatusBadgeStyle,
	getSessionStatusTooltip,
	isApprovalState,
} from "./session-status";

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		updatedAt: Date.now(),
		...overrides,
	});
}

function withInteractionStatus(status: "response_submitted" | "resolution_unknown"): RuntimeTaskSessionSummary {
	return makeSummary({
		state: "awaiting_review",
		reviewReason: status === "resolution_unknown" ? "error" : "hook",
		outstandingInteraction: {
			provider: "codex",
			kind: "permission",
			status,
			requestEventName: "PermissionRequest",
			openedAt: 1,
			updatedAt: 2,
			responseSubmittedAt: 2,
			responseKind: "submit",
			sessionInstanceId: "process-1",
			providerSessionId: "session-1",
			turnId: "turn-1",
			promptId: null,
			toolUseId: "tool-1",
			elicitationId: null,
			providerAgentId: null,
			toolName: "Bash",
		},
	});
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
					outstandingInteraction: createTestTaskOutstandingInteraction({
						provider: "codex",
						kind: "permission",
						requestEventName: "PermissionRequest",
					}),
				}),
			),
		).toBe("Waiting for approval");
	});

	it("returns 'Waiting for input' for a structured Claude attention wait", () => {
		expect(
			describeSessionState(
				makeSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					outstandingInteraction: createTestTaskOutstandingInteraction(),
				}),
			),
		).toBe("Waiting for input");
	});

	it("distinguishes a submitted response from confirmed running work", () => {
		expect(describeSessionState(withInteractionStatus("response_submitted"))).toBe(
			"Response sent — awaiting agent confirmation",
		);
	});

	it("surfaces an unknown response outcome after provider process loss", () => {
		expect(describeSessionState(withInteractionStatus("resolution_unknown"))).toBe("Response outcome unknown");
	});

	it("returns 'Interrupted' for an unproven legacy attention reason", () => {
		expect(describeSessionState(makeSummary({ state: "awaiting_review", reviewReason: "attention" }))).toBe(
			"Interrupted",
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

	it("returns needs_input for a durable permission interaction", () => {
		expect(
			getSessionStatusBadgeStyle(
				makeSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					outstandingInteraction: createTestTaskOutstandingInteraction({
						provider: "codex",
						kind: "permission",
						requestEventName: "PermissionRequest",
					}),
				}),
			),
		).toBe("needs_input");
	});

	it("returns review for non-permission hook", () => {
		expect(getSessionStatusBadgeStyle(makeSummary({ state: "awaiting_review", reviewReason: "hook" }))).toBe(
			"review",
		);
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

	it("returns true for an exact durable permission interaction", () => {
		expect(
			isApprovalState(
				makeSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					outstandingInteraction: createTestTaskOutstandingInteraction({
						kind: "permission",
						requestEventName: "PermissionRequest",
					}),
				}),
			),
		).toBe(true);
	});

	it("does not promote permissionRequest display activity into approval authority", () => {
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
		).toBe(false);
	});

	it("does not promote permission_prompt notification text into approval authority", () => {
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
		).toBe(false);
	});

	it("does not promote permission.asked notification text into approval authority", () => {
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
		).toBe(false);
	});

	it("does not promote rendered approval text into approval authority", () => {
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
		).toBe(false);
	});
});
