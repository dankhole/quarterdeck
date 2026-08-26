import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core";
import {
	deriveTaskIndicatorState,
	didEnterTaskReviewReady,
	getRuntimeSessionWorkColumn,
	isPermissionActivity,
} from "../../../src/core";
import {
	createTestTaskHookActivity,
	createTestTaskNativeWorkEvidence,
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

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

describe("getRuntimeSessionWorkColumn", () => {
	it("centralizes the board projection for runtime-owned work states", () => {
		expect(getRuntimeSessionWorkColumn(makeSummary({ state: "running" }))).toBe("in_progress");
		expect(getRuntimeSessionWorkColumn(makeSummary({ state: "awaiting_review" }))).toBe("review");
		expect(getRuntimeSessionWorkColumn(makeSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe(
			"review",
		);
		expect(getRuntimeSessionWorkColumn(makeSummary({ state: "awaiting_review", reviewReason: "interrupted" }))).toBe(
			"review",
		);
		expect(getRuntimeSessionWorkColumn(makeSummary({ state: "idle" }))).toBeNull();
	});
});

describe("didEnterTaskReviewReady", () => {
	it("emits only for a newly actionable ordinary review result", () => {
		const running = makeSummary({ state: "running", reviewReason: null });
		const ordinaryReview = makeSummary({ state: "awaiting_review", reviewReason: "hook" });
		const stalled = makeSummary({ state: "awaiting_review", reviewReason: "stalled" });
		const failedExit = makeSummary({ state: "awaiting_review", reviewReason: "exit", exitCode: 1 });

		expect(didEnterTaskReviewReady(running, ordinaryReview)).toBe(true);
		expect(didEnterTaskReviewReady(running, stalled)).toBe(false);
		expect(didEnterTaskReviewReady(running, failedExit)).toBe(false);
		expect(didEnterTaskReviewReady(ordinaryReview, ordinaryReview)).toBe(false);
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
				outstandingInteraction: createTestTaskOutstandingInteraction({
					provider: "claude",
					kind: "permission",
				}),
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
				outstandingInteraction: createTestTaskOutstandingInteraction({
					provider: "codex",
					kind: "permission",
				}),
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

	it("lets an exact waiting interaction override a contradictory Running field", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "running",
				agentId: "codex",
				sessionInstanceId: "process-1",
				pid: 123,
				nativeWorkEvidence: createTestTaskNativeWorkEvidence(),
				outstandingInteraction: createTestTaskOutstandingInteraction({
					provider: "codex",
					kind: "permission",
				}),
			}),
		);

		expect(indicator.publicStatus).toBe("needs_input");
		expect(indicator.kind).toBe("approval_required");
		expect(
			getRuntimeSessionWorkColumn(
				makeSummary({
					state: "running",
					agentId: "codex",
					sessionInstanceId: "process-1",
					pid: 123,
					nativeWorkEvidence: createTestTaskNativeWorkEvidence(),
					outstandingInteraction: createTestTaskOutstandingInteraction({ provider: "codex", kind: "permission" }),
				}),
			),
		).toBe("review");
	});

	it.each(["codex", "pi"] as const)(
		"fails a supported %s Running claim closed without matching evidence",
		(agentId) => {
			const indicator = deriveTaskIndicatorState(
				makeSummary({ state: "running", agentId, sessionInstanceId: "process-1", pid: 123 }),
			);

			expect(indicator.publicStatus).toBe("review");
			expect(indicator.kind).toBe("unconfirmed");
		},
	);

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

	it.each([
		["response_submitted", "response_pending", false, null],
		["resolution_unknown", "interaction_unknown", false, "failure"],
	] as const)("projects %s interactions without claiming Needs Input", (status, kind, needsInput, notification) => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
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
			}),
		);

		expect(indicator).toMatchObject({ kind, needsInput, notification });
	});

	it("marks a structured Claude attention wait as needs_input without treating it as approval", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "attention",
				outstandingInteraction: {
					provider: "claude",
					kind: "question",
					status: "waiting",
					requestEventName: "PreToolUse",
					openedAt: 1,
					updatedAt: 1,
					responseSubmittedAt: null,
					responseKind: null,
					sessionInstanceId: "process-1",
					providerSessionId: "session-1",
					turnId: null,
					promptId: null,
					toolUseId: "tool-1",
					elicitationId: null,
					providerAgentId: null,
					toolName: "AskUserQuestion",
				},
			}),
		);

		expect(indicator.kind).toBe("needs_input");
		expect(indicator.needsInput).toBe(true);
		expect(indicator.approvalRequired).toBe(false);
		expect(indicator.tone).toBe("review");
		expect(indicator.notification).toBe("review");
	});

	it("does not attribute Claude Agent View notifications to the current task", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "attention",
				latestHookActivity: createTestTaskHookActivity({
					hookEventName: "Notification",
					notificationType: "agent_needs_input",
					source: "claude",
				}),
			}),
		);

		expect(indicator).toMatchObject({ kind: "interrupted", needsInput: false, notification: null });
	});

	it.each(["permission_prompt", "elicitation_dialog"])(
		"does not revive a task wait from a legacy Claude %s notification",
		(notificationType) => {
			const summary = makeSummary({
				state: "awaiting_review",
				reviewReason: notificationType === "permission_prompt" ? "hook" : "attention",
				latestHookActivity: createTestTaskHookActivity({
					hookEventName: "Notification",
					notificationType,
					activityText: notificationType === "permission_prompt" ? "Waiting for approval" : "Needs input",
					source: "claude",
				}),
			});

			expect(isPermissionActivity(summary.latestHookActivity)).toBe(false);
			expect(deriveTaskIndicatorState(summary)).toMatchObject({ needsInput: false });
		},
	);

	it("does not fabricate needs_input from an unproven legacy attention reason", () => {
		const indicator = deriveTaskIndicatorState(
			makeSummary({
				state: "awaiting_review",
				reviewReason: "attention",
			}),
		);

		expect(indicator.kind).toBe("interrupted");
		expect(indicator.needsInput).toBe(false);
		expect(indicator.notification).toBeNull();
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
