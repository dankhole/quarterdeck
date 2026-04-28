import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core";
import { deriveTaskIndicatorState, isPermissionActivity } from "../../../src/core";
import { createTestTaskHookActivity, createTestTaskSessionSummary } from "../../utilities/task-session-factory";

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		updatedAt: Date.now(),
		...overrides,
	});
}

describe("isPermissionActivity", () => {
	it("detects Claude PermissionRequest metadata", () => {
		expect(
			isPermissionActivity({
				hookEventName: "PermissionRequest",
				notificationType: null,
				activityText: null,
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				source: "claude",
				conversationSummaryText: null,
			}),
		).toBe(true);
	});

	it("detects Codex permission.asked metadata", () => {
		expect(
			isPermissionActivity({
				hookEventName: null,
				notificationType: "permission.asked",
				activityText: "Waiting for approval",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				source: "codex",
				conversationSummaryText: null,
			}),
		).toBe(true);
	});
});

describe("deriveTaskIndicatorState", () => {
	it("returns idle as the baseline state", () => {
		const indicator = deriveTaskIndicatorState(makeSummary());

		expect(indicator.kind).toBe("idle");
		expect(indicator.tone).toBe("neutral");
		expect(indicator.column).toBe("stopped");
		expect(indicator.notification).toBeNull();
	});

	it("returns running semantics for active sessions", () => {
		const indicator = deriveTaskIndicatorState(makeSummary({ state: "running" }));

		expect(indicator.kind).toBe("running");
		expect(indicator.tone).toBe("running");
		expect(indicator.column).toBe("active");
		expect(indicator.notification).toBeNull();
	});

	it("normalizes Claude permission requests into approval_required", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: createTestTaskHookActivity({
					hookEventName: "PermissionRequest",
					notificationType: "permission_prompt",
					source: "claude",
				}),
			}),
		);

		expect(indicator.kind).toBe("approval_required");
		expect(indicator.approvalRequired).toBe(true);
		expect(indicator.notification).toBe("permission");
	});

	it("normalizes Codex permission requests into approval_required", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: createTestTaskHookActivity({
					notificationType: "permission.asked",
					activityText: "Waiting for approval",
					source: "codex",
				}),
			}),
		);

		expect(indicator.kind).toBe("approval_required");
		expect(indicator.approvalRequired).toBe(true);
		expect(indicator.notification).toBe("permission");
	});

	it("distinguishes review_ready from approval_required", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: createTestTaskHookActivity({
					hookEventName: "Stop",
					activityText: "Final: Done",
					finalMessage: "Done",
					source: "claude",
				}),
			}),
		);

		expect(indicator.kind).toBe("review_ready");
		expect(indicator.notification).toBe("review");
		expect(indicator.approvalRequired).toBe(false);
	});

	it("marks attention as needs_input without treating it as approval", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "attention",
			}),
		);

		expect(indicator.kind).toBe("needs_input");
		expect(indicator.needsInput).toBe(true);
		expect(indicator.approvalRequired).toBe(false);
		expect(indicator.tone).toBe("review");
		expect(indicator.notification).toBe("review");
	});

	it("marks completed review with success notification for zero exit", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "exit",
				exitCode: 0,
			}),
		);

		expect(indicator.kind).toBe("completed");
		expect(indicator.tone).toBe("review");
		expect(indicator.notification).toBe("review");
		expect(indicator.reviewReady).toBe(true);
	});

	it("marks completed review with failure notification for non-zero exit", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "exit",
				exitCode: 1,
			}),
		);

		expect(indicator.kind).toBe("completed");
		expect(indicator.notification).toBe("failure");
		expect(indicator.reviewReady).toBe(true);
	});

	it("marks failure states explicitly", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "error",
			}),
		);

		expect(indicator.kind).toBe("error");
		expect(indicator.failure).toBe(true);
		expect(indicator.notification).toBe("failure");
	});

	it("marks top-level failed sessions explicitly", () => {
		const indicator = deriveTaskIndicatorState(makeSummary({ state: "failed" }));

		expect(indicator.kind).toBe("failed");
		expect(indicator.failure).toBe(true);
		expect(indicator.tone).toBe("error");
		expect(indicator.notification).toBe("failure");
	});

	it("marks top-level interrupted sessions as silent errors", () => {
		const indicator = deriveTaskIndicatorState(makeSummary({ state: "interrupted" }));

		expect(indicator.kind).toBe("interrupted");
		expect(indicator.tone).toBe("error");
		expect(indicator.column).toBe("silent");
		expect(indicator.notification).toBeNull();
	});

	it("marks interrupted review as neutral and silent", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "interrupted",
			}),
		);

		expect(indicator.kind).toBe("interrupted");
		expect(indicator.tone).toBe("neutral");
		expect(indicator.column).toBe("silent");
		expect(indicator.notification).toBeNull();
	});

	it("marks stalled review as review-ready without a sound event", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "stalled",
			}),
		);

		expect(indicator.kind).toBe("stalled");
		expect(indicator.tone).toBe("review");
		expect(indicator.reviewReady).toBe(true);
		expect(indicator.notification).toBeNull();
	});
});
