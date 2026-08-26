import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core";
import { LEGACY_STARTUP_SEMANTIC_STATE_WARNING, reduceSessionTransition } from "../../../src/terminal";
import {
	createTestProviderHookEvent,
	createTestTaskHookActivity,
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		state: "running",
		agentId: "claude",
		sessionLaunchPath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		...overrides,
	});
}

describe("reduceSessionTransition", () => {
	describe("agent.permission-prompt", () => {
		it("projects a visible Codex approval into an actionable review wait", () => {
			const summary = createSummary({ agentId: "codex" });

			const result = reduceSessionTransition(summary, { type: "agent.permission-prompt" });

			expect(result.changed).toBe(true);
			expect(result.patch).toMatchObject({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: {
					activityText: "Waiting for approval",
					hookEventName: "RenderedApprovalOverlay",
					notificationType: "permission.asked",
					source: "codex",
				},
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("opens a later rendered approval after the prior response was submitted", () => {
			const summary = createSummary({
				agentId: "codex",
				state: "awaiting_review",
				reviewReason: "hook",
				outstandingInteraction: {
					provider: "codex",
					kind: "permission",
					status: "response_submitted",
					requestEventName: "RenderedApprovalOverlay",
					openedAt: 100,
					updatedAt: 110,
					responseSubmittedAt: 110,
					responseKind: "cancel",
					sessionInstanceId: "process-1",
					providerSessionId: null,
					turnId: null,
					promptId: null,
					toolUseId: null,
					elicitationId: null,
					providerAgentId: null,
					toolName: null,
				},
			});

			const result = reduceSessionTransition(summary, {
				type: "agent.permission-prompt",
				occurredAt: 120,
			});

			expect(result.patch.outstandingInteraction).toMatchObject({
				status: "waiting",
				openedAt: 120,
				responseSubmittedAt: null,
			});
		});

		it("does not infer approval state for another agent", () => {
			const result = reduceSessionTransition(createSummary({ agentId: "claude" }), {
				type: "agent.permission-prompt",
			});

			expect(result).toEqual({ changed: false, patch: {}, clearAttentionBuffer: false });
		});
	});

	describe("reconciliation.launch_path_missing", () => {
		it("moves an active session to error review without claiming the process exited", () => {
			const summary = createSummary({
				state: "running",
				pid: 1234,
				latestHookActivity: {
					activityText: "Working",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "PreToolUse",
					notificationType: null,
					source: "codex",
					conversationSummaryText: null,
				},
			});

			const result = reduceSessionTransition(summary, {
				type: "reconciliation.launch_path_missing",
				warningMessage: "Launch folder missing.",
			});

			expect(result.patch).toMatchObject({
				state: "awaiting_review",
				reviewReason: "error",
				latestHookActivity: null,
				outstandingInteraction: null,
				warningMessage: "Launch folder missing.",
			});
			expect(result.patch).not.toHaveProperty("pid");
		});
	});

	describe("provider.hook to_review", () => {
		it("lets new hook evidence classify a semantically uncertain legacy recovery", () => {
			const summary = createSummary({
				state: "awaiting_review",
				reviewReason: "interrupted",
				startupRecoverySemanticStateUncertain: true,
				warningMessage: LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
			});
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_review"));

			expect(result.patch).toMatchObject({
				state: "awaiting_review",
				reviewReason: "hook",
				startupRecoverySemanticStateUncertain: false,
				warningMessage: null,
			});
		});

		it("transitions from running to awaiting_review with reason 'hook'", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_review"));

			expect(result.changed).toBe(true);
			expect(result.patch).toMatchObject({
				state: "awaiting_review",
				reviewReason: "hook",
				outstandingInteraction: null,
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("derives attention from a real Claude question event", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(
				summary,
				createTestProviderHookEvent("to_review", {
					hookEventName: "PreToolUse",
					metadata: { toolName: "AskUserQuestion", toolUseId: "tool-1", promptId: "prompt-1" },
				}),
			);

			expect(result.changed).toBe(true);
			expect(result.patch).toMatchObject({
				state: "awaiting_review",
				reviewReason: "attention",
				outstandingInteraction: { kind: "question", status: "waiting", toolUseId: "tool-1" },
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("derives error from a real Claude StopFailure event", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(
				summary,
				createTestProviderHookEvent("to_review", { hookEventName: "StopFailure" }),
			);

			expect(result.changed).toBe(true);
			expect(result.patch).toMatchObject({ state: "awaiting_review", reviewReason: "error" });
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("no-op from awaiting_review", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_review"));

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("lets a confirmed current completion replace an interrupted review", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "interrupted" });
			const unconfirmed = reduceSessionTransition(
				summary,
				createTestProviderHookEvent("to_review", { sessionEvidence: "unconfirmed" }),
			);
			const confirmed = reduceSessionTransition(summary, createTestProviderHookEvent("to_review"));

			expect(unconfirmed.changed).toBe(false);
			expect(confirmed).toMatchObject({
				changed: true,
				patch: { state: "awaiting_review", reviewReason: "hook" },
			});
		});

		it("no-op from idle", () => {
			const summary = createSummary({ state: "idle", pid: null });
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_review"));

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("does not complete Interrupted without current live-session evidence", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "interrupted", pid: null });
			const result = reduceSessionTransition(
				summary,
				createTestProviderHookEvent("to_review", { sessionEvidence: "unconfirmed" }),
			);

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("no-op from error Review", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "error", pid: null });
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_review"));

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});
	});

	describe("provider.hook to_in_progress", () => {
		it("lets new running evidence classify a semantically uncertain legacy recovery", () => {
			const summary = createSummary({
				state: "awaiting_review",
				reviewReason: "interrupted",
				startupRecoverySemanticStateUncertain: true,
				warningMessage: LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
			});
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_in_progress"));

			expect(result.patch).toMatchObject({
				state: "running",
				reviewReason: null,
				startupRecoverySemanticStateUncertain: false,
				warningMessage: null,
			});
		});

		it("transitions from awaiting_review (reason 'hook') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_in_progress"));

			expect(result.changed).toBe(true);
			expect(result.patch).toMatchObject({
				state: "running",
				reviewReason: null,
				outstandingInteraction: null,
				stalledSince: null,
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("transitions from awaiting_review (reason 'attention') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "attention" });
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_in_progress"));

			expect(result.changed).toBe(true);
			expect(result.patch).toMatchObject({
				state: "running",
				reviewReason: null,
				outstandingInteraction: null,
				stalledSince: null,
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("transitions from awaiting_review (reason 'error') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "error" });
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_in_progress"));

			expect(result.changed).toBe(true);
			expect(result.patch).toMatchObject({
				state: "running",
				reviewReason: null,
				outstandingInteraction: null,
				stalledSince: null,
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("transitions from awaiting_review (reason 'exit') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "exit" });
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_in_progress"));

			expect(result.changed).toBe(true);
			expect(result.patch).toMatchObject({
				state: "running",
				reviewReason: null,
				outstandingInteraction: null,
				stalledSince: null,
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("refreshes bounded provider evidence while already running", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_in_progress"));

			expect(result.changed).toBe(true);
			expect(result.patch.nativeWorkEvidence).toMatchObject({
				provider: "claude",
				sessionInstanceId: "process-1",
			});
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("requires current live-session evidence for an interrupted review", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "interrupted" });
			const unconfirmed = reduceSessionTransition(
				summary,
				createTestProviderHookEvent("to_in_progress", { sessionEvidence: "unconfirmed" }),
			);
			const confirmed = reduceSessionTransition(summary, createTestProviderHookEvent("to_in_progress"));

			expect(unconfirmed.changed).toBe(false);
			expect(unconfirmed.patch).toEqual({});
			expect(confirmed.changed).toBe(true);
			expect(confirmed.patch).toMatchObject({ state: "running", reviewReason: null });
		});
	});

	describe("interrupt.recovery", () => {
		it("transitions from running to an interrupted review without fabricating attention", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "interrupt.recovery" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({
				state: "awaiting_review",
				reviewReason: "interrupted",
				latestHookActivity: null,
				outstandingInteraction: null,
				nativeWorkEvidence: null,
				stalledSince: null,
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("no-op from awaiting_review", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const result = reduceSessionTransition(summary, { type: "interrupt.recovery" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("no-op from idle", () => {
			const summary = createSummary({ state: "idle", pid: null });
			const result = reduceSessionTransition(summary, { type: "interrupt.recovery" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});
	});

	describe("agent.rendered-turn-interrupted", () => {
		it("conservatively moves Running to interrupted Review", () => {
			const summary = createSummary({ state: "running", agentId: "codex", reviewReason: null });
			const result = reduceSessionTransition(summary, { type: "agent.rendered-turn-interrupted" });

			expect(result).toMatchObject({
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "interrupted",
					outstandingInteraction: null,
				},
			});
		});

		it.each(["waiting", "response_submitted"] as const)(
			"retires a current Codex permission in %s into interrupted Review",
			(status) => {
				const summary = createSummary({
					state: "awaiting_review",
					agentId: "codex",
					reviewReason: "hook",
					latestHookActivity: createTestTaskHookActivity({
						hookEventName: "PermissionRequest",
						notificationType: "permission.asked",
						source: "codex",
					}),
					outstandingInteraction: createTestTaskOutstandingInteraction({
						provider: "codex",
						kind: "permission",
						status,
						providerAgentId: null,
						responseSubmittedAt: status === "response_submitted" ? 2 : null,
						responseKind: status === "response_submitted" ? "cancel" : null,
					}),
				});

				expect(reduceSessionTransition(summary, { type: "agent.rendered-turn-interrupted" })).toMatchObject({
					changed: true,
					patch: {
						state: "awaiting_review",
						reviewReason: "interrupted",
						latestHookActivity: null,
						outstandingInteraction: null,
						nativeWorkEvidence: null,
						stalledSince: null,
					},
					clearAttentionBuffer: true,
				});
			},
		);

		it("cannot rewrite ordinary Review", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			expect(reduceSessionTransition(summary, { type: "agent.rendered-turn-interrupted" }).changed).toBe(false);
		});

		it("cannot retire another provider's interaction", () => {
			const summary = createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				outstandingInteraction: createTestTaskOutstandingInteraction(),
			});
			expect(reduceSessionTransition(summary, { type: "agent.rendered-turn-interrupted" }).changed).toBe(false);
		});

		it("cannot rewrite another provider's Running session", () => {
			const summary = createSummary({ state: "running", agentId: "claude" });
			expect(reduceSessionTransition(summary, { type: "agent.rendered-turn-interrupted" }).changed).toBe(false);
		});
	});

	describe("user.stop", () => {
		it("marks running sessions as interrupted review and clears hook activity", () => {
			const summary = createSummary({
				state: "running",
				latestHookActivity: {
					activityText: "Waiting for approval",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "PermissionRequest",
					notificationType: "permission.asked",
					source: "claude",
					conversationSummaryText: null,
				},
			});
			const result = reduceSessionTransition(summary, { type: "user.stop" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({
				state: "awaiting_review",
				reviewReason: "interrupted",
				latestHookActivity: null,
				outstandingInteraction: null,
				nativeWorkEvidence: null,
				stalledSince: null,
			});
			expect(result.patch.pid).toBeUndefined();
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("preserves completed awaiting review sessions", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const result = reduceSessionTransition(summary, { type: "user.stop" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
		});

		it("marks awaiting input review sessions as interrupted review", () => {
			const summary = createSummary({
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
			});
			const result = reduceSessionTransition(summary, { type: "user.stop" });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("awaiting_review");
			expect(result.patch.reviewReason).toBe("interrupted");
		});
	});

	describe("provider.hook from legacy stalled review", () => {
		it("transitions from awaiting_review (reason 'stalled') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "stalled", stalledSince: Date.now() });
			const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_in_progress"));

			expect(result.changed).toBe(true);
			expect(result.patch).toMatchObject({
				state: "running",
				reviewReason: null,
				outstandingInteraction: null,
				stalledSince: null,
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});
	});

	describe("process.exit", () => {
		it("exit code 0 produces state awaiting_review with reason 'exit'", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: 0, interrupted: false });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("awaiting_review");
			expect(result.patch.reviewReason).toBe("exit");
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("exit code 1 produces state awaiting_review with reason 'error'", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: 1, interrupted: false });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("awaiting_review");
			expect(result.patch.reviewReason).toBe("error");
		});

		it("exit code null produces state awaiting_review with reason 'error'", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: null, interrupted: false });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("awaiting_review");
			expect(result.patch.reviewReason).toBe("error");
		});

		it("interrupted flag produces Review with reason 'interrupted'", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: 1, interrupted: true });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("awaiting_review");
			expect(result.patch.reviewReason).toBe("interrupted");
		});

		it("interrupted flag overrides exit code 0", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: 0, interrupted: true });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("awaiting_review");
			expect(result.patch.reviewReason).toBe("interrupted");
		});

		it("always sets pid to null in patch", () => {
			const summary = createSummary({ state: "running", pid: 9999 });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: 0, interrupted: false });

			expect(result.patch.pid).toBeNull();
		});

		it("preserves review reason when already in awaiting_review", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: 0, interrupted: false });

			expect(result.changed).toBe(true);
			// Process dying after the agent already handed off is cleanup noise —
			// the review reason should stay as "hook", not flip to "exit".
			expect(result.patch.state).toBeUndefined();
			expect(result.patch.reviewReason).toBeUndefined();
			expect(result.patch.pid).toBeNull();
			expect(result.patch.exitCode).toBe(0);
		});

		it("preserves interrupted Review after an explicit stop", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "interrupted", pid: null });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: 0, interrupted: false });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBeUndefined();
			expect(result.patch.reviewReason).toBeUndefined();
			expect(result.patch.pid).toBeNull();
			expect(result.patch.exitCode).toBe(0);
		});

		it("preserves interrupted review after an explicit stop", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "interrupted", pid: 1234 });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: 0, interrupted: true });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBeUndefined();
			expect(result.patch.reviewReason).toBeUndefined();
			expect(result.patch.pid).toBeNull();
			expect(result.patch.exitCode).toBe(0);
		});
	});

	describe("startup_recovery.exhausted", () => {
		it("marks an unconfirmed final process as an error while leaving it available for manual restart", () => {
			const summary = createSummary({
				state: "awaiting_review",
				reviewReason: "attention",
				pid: 4321,
				resumeSessionId: "session-1",
			});
			const result = reduceSessionTransition(summary, {
				type: "startup_recovery.exhausted",
				processStillRunning: true,
				clearResumeSessionId: false,
				warningMessage: "Recovery remains unconfirmed.",
				fallbackReviewState: null,
			});

			expect(result.patch).toEqual({
				state: "awaiting_review",
				reviewReason: "error",
				latestHookActivity: null,
				outstandingInteraction: null,
				nativeWorkEvidence: null,
				stalledSince: null,
				startupRecoveryRequired: false,
				warningMessage: "Recovery remains unconfirmed.",
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("moves a stopped launch to error review and can clear its failed target", () => {
			const summary = createSummary({
				state: "awaiting_review",
				reviewReason: "error",
				pid: null,
				resumeSessionId: "missing-session",
			});
			const result = reduceSessionTransition(summary, {
				type: "startup_recovery.exhausted",
				processStillRunning: false,
				clearResumeSessionId: true,
				warningMessage: "Recovery failed.",
				fallbackReviewState: null,
			});

			expect(result.patch).toEqual({
				state: "awaiting_review",
				reviewReason: "error",
				pid: null,
				latestHookActivity: null,
				outstandingInteraction: null,
				nativeWorkEvidence: null,
				stalledSince: null,
				startupRecoveryRequired: false,
				resumeSessionId: null,
				warningMessage: "Recovery failed.",
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("preserves completed review meaning when only the interactive chat failed to restore", () => {
			const activity = {
				activityText: "Completed",
				toolName: null,
				toolInputSummary: null,
				finalMessage: "Implemented and verified.",
				hookEventName: "Stop",
				notificationType: null,
				source: "codex",
				conversationSummaryText: "Implemented and verified.",
			};
			const result = reduceSessionTransition(
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					pid: 4321,
					lastHookAt: 500,
					latestHookActivity: activity,
					startupRecoveryRequired: true,
				}),
				{
					type: "startup_recovery.exhausted",
					processStillRunning: true,
					clearResumeSessionId: false,
					warningMessage: "Chat restoration failed.",
					fallbackReviewState: {
						reviewReason: "hook",
						lastHookAt: 500,
						latestHookActivity: activity,
					},
				},
			);

			expect(result.patch).toEqual({
				state: "awaiting_review",
				reviewReason: "hook",
				lastHookAt: 500,
				latestHookActivity: activity,
				outstandingInteraction: null,
				nativeWorkEvidence: null,
				stalledSince: null,
				startupRecoveryRequired: false,
				warningMessage: "Chat restoration failed.",
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});
	});
});
