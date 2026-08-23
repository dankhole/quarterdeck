import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core";
import { canReturnToRunning, reduceSessionTransition } from "../../../src/terminal";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

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

describe("canReturnToRunning", () => {
	it("returns true for 'attention'", () => {
		expect(canReturnToRunning("attention")).toBe(true);
	});

	it("returns true for 'hook'", () => {
		expect(canReturnToRunning("hook")).toBe(true);
	});

	it("returns true for 'error'", () => {
		expect(canReturnToRunning("error")).toBe(true);
	});

	it("returns true for 'exit'", () => {
		expect(canReturnToRunning("exit")).toBe(true);
	});

	it("returns true for legacy 'stalled'", () => {
		expect(canReturnToRunning("stalled")).toBe(true);
	});

	it("returns false for 'interrupted'", () => {
		expect(canReturnToRunning("interrupted")).toBe(false);
	});
});

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
					hookEventName: "PermissionRequest",
					notificationType: "permission.asked",
					source: "codex",
				},
			});
			expect(result.clearAttentionBuffer).toBe(true);
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
				warningMessage: "Launch folder missing.",
			});
			expect(result.patch).not.toHaveProperty("pid");
		});
	});

	describe("hook.to_review", () => {
		it("transitions from running to awaiting_review with reason 'hook'", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "hook.to_review" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({ state: "awaiting_review", reviewReason: "hook" });
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("no-op from awaiting_review", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const result = reduceSessionTransition(summary, { type: "hook.to_review" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("no-op from idle", () => {
			const summary = createSummary({ state: "idle", pid: null });
			const result = reduceSessionTransition(summary, { type: "hook.to_review" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("no-op from interrupted", () => {
			const summary = createSummary({ state: "interrupted", reviewReason: "interrupted", pid: null });
			const result = reduceSessionTransition(summary, { type: "hook.to_review" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("no-op from failed", () => {
			const summary = createSummary({ state: "failed", pid: null });
			const result = reduceSessionTransition(summary, { type: "hook.to_review" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});
	});

	describe("hook.to_in_progress", () => {
		it("transitions from awaiting_review (reason 'hook') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({ state: "running", reviewReason: null, stalledSince: null });
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("transitions from awaiting_review (reason 'attention') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "attention" });
			const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({ state: "running", reviewReason: null, stalledSince: null });
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("transitions from awaiting_review (reason 'error') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "error" });
			const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({ state: "running", reviewReason: null, stalledSince: null });
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("transitions from awaiting_review (reason 'exit') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "exit" });
			const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({ state: "running", reviewReason: null, stalledSince: null });
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("no-op from running", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("no-op from awaiting_review with reason 'interrupted'", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "interrupted" });
			const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});
	});

	describe("agent.prompt-ready", () => {
		it("transitions from awaiting_review (reason 'hook') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const result = reduceSessionTransition(summary, { type: "agent.prompt-ready" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({ state: "running", reviewReason: null, stalledSince: null });
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("no-op from running", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "agent.prompt-ready" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});

		it("no-op from awaiting_review with non-returnable reason", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "interrupted" });
			const result = reduceSessionTransition(summary, { type: "agent.prompt-ready" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
			expect(result.clearAttentionBuffer).toBe(false);
		});
	});

	describe("user.responded", () => {
		it("moves an approval wait to running and clears its hook activity", () => {
			const summary = createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: {
					activityText: "Waiting for approval",
					toolName: "Bash",
					toolInputSummary: "npm test",
					finalMessage: null,
					hookEventName: "PermissionRequest",
					notificationType: "permission.asked",
					source: "codex",
					conversationSummaryText: null,
				},
			});

			const result = reduceSessionTransition(summary, { type: "user.responded" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({
				state: "running",
				reviewReason: null,
				latestHookActivity: null,
				stalledSince: null,
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("moves an attention wait to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "attention" });

			const result = reduceSessionTransition(summary, { type: "user.responded" });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("running");
		});

		it("does not move an ordinary review-ready card", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });

			const result = reduceSessionTransition(summary, { type: "user.responded" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
		});
	});

	describe("user.submitted", () => {
		it("starts a new turn immediately from a review-ready live session", () => {
			const summary = createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: {
					activityText: "Ready for review",
					toolName: null,
					toolInputSummary: null,
					finalMessage: "Finished",
					hookEventName: "Stop",
					notificationType: null,
					source: "codex",
					conversationSummaryText: "Finished",
				},
			});

			const result = reduceSessionTransition(summary, { type: "user.submitted" });

			expect(result.changed).toBe(true);
			expect(result.patch).toMatchObject({
				state: "running",
				reviewReason: null,
				latestHookActivity: null,
			});
		});

		it("does not revive an explicitly interrupted session", () => {
			const summary = createSummary({ state: "interrupted", reviewReason: "interrupted" });

			expect(reduceSessionTransition(summary, { type: "user.submitted" }).changed).toBe(false);
		});
	});

	describe("interrupt.recovery", () => {
		it("transitions from running to awaiting_review with reason 'attention'", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "interrupt.recovery" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({ state: "awaiting_review", reviewReason: "attention" });
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
			const summary = createSummary({ state: "awaiting_review", reviewReason: "attention" });
			const result = reduceSessionTransition(summary, { type: "user.stop" });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("awaiting_review");
			expect(result.patch.reviewReason).toBe("interrupted");
		});
	});

	describe("hook.to_in_progress from legacy stalled review", () => {
		it("transitions from awaiting_review (reason 'stalled') to running", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "stalled", stalledSince: Date.now() });
			const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });

			expect(result.changed).toBe(true);
			expect(result.patch).toEqual({ state: "running", reviewReason: null, stalledSince: null });
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

		it("interrupted flag produces state 'interrupted' with reason 'interrupted'", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: 1, interrupted: true });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("interrupted");
			expect(result.patch.reviewReason).toBe("interrupted");
		});

		it("interrupted flag overrides exit code 0", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "process.exit", exitCode: 0, interrupted: true });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("interrupted");
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

		it("preserves interrupted state after an explicit stop", () => {
			const summary = createSummary({ state: "interrupted", reviewReason: "interrupted", pid: null });
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
			});

			expect(result.patch).toEqual({
				state: "awaiting_review",
				reviewReason: "error",
				latestHookActivity: null,
				stalledSince: null,
				warningMessage: "Recovery remains unconfirmed.",
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("moves a stopped launch to error review and can clear its failed target", () => {
			const summary = createSummary({ state: "failed", pid: null, resumeSessionId: "missing-session" });
			const result = reduceSessionTransition(summary, {
				type: "startup_recovery.exhausted",
				processStillRunning: false,
				clearResumeSessionId: true,
				warningMessage: "Recovery failed.",
			});

			expect(result.patch).toEqual({
				state: "awaiting_review",
				reviewReason: "error",
				pid: null,
				latestHookActivity: null,
				stalledSince: null,
				resumeSessionId: null,
				warningMessage: "Recovery failed.",
			});
			expect(result.clearAttentionBuffer).toBe(true);
		});
	});
});
