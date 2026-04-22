import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core";
import { canReturnToRunning, reduceSessionTransition } from "../../../src/terminal";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		sessionLaunchPath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
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

	it("returns true for 'stalled'", () => {
		expect(canReturnToRunning("stalled")).toBe(true);
	});

	it("returns false for 'interrupted'", () => {
		expect(canReturnToRunning("interrupted")).toBe(false);
	});
});

describe("reduceSessionTransition", () => {
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

	describe("reconciliation.stalled", () => {
		it("transitions from running to awaiting_review with reason 'stalled'", () => {
			const summary = createSummary({ state: "running" });
			const result = reduceSessionTransition(summary, { type: "reconciliation.stalled" });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("awaiting_review");
			expect(result.patch.reviewReason).toBe("stalled");
			expect(result.patch.stalledSince).toEqual(expect.any(Number));
			expect(result.clearAttentionBuffer).toBe(true);
		});

		it("no-op from awaiting_review", () => {
			const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const result = reduceSessionTransition(summary, { type: "reconciliation.stalled" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
		});

		it("no-op from idle", () => {
			const summary = createSummary({ state: "idle", pid: null });
			const result = reduceSessionTransition(summary, { type: "reconciliation.stalled" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
		});
	});

	describe("hook.to_in_progress from stalled review", () => {
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
	});
});
