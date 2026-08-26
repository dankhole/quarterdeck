import { describe, expect, it } from "vitest";

import type {
	RuntimeHookEvent,
	RuntimeHookMetadata,
	RuntimeTaskOutstandingInteraction,
	RuntimeTaskSessionSummary,
} from "../../../src/core";
import { deriveTaskIndicatorState } from "../../../src/core";
import { reduceSessionTransition } from "../../../src/terminal";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

function running(agentId: "codex" | "claude" | "pi"): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		state: "running",
		agentId,
		sessionInstanceId: "process-1",
		resumeSessionId: "session-1",
		pid: 123,
	});
}

function providerHook(
	event: RuntimeHookEvent,
	metadata: RuntimeHookMetadata,
	options: { occurredAt?: number; correlatedToolUseId?: string | null } = {},
): Extract<Parameters<typeof reduceSessionTransition>[1], { type: "provider.hook" }> {
	return {
		type: "provider.hook" as const,
		event,
		metadata: { sessionInstanceId: "process-1", sessionId: "session-1", ...metadata },
		occurredAt: options.occurredAt ?? 100,
		correlatedToolUseId: options.correlatedToolUseId ?? null,
		sessionEvidence: "live",
	};
}

function apply(
	summary: RuntimeTaskSessionSummary,
	event: Parameters<typeof reduceSessionTransition>[1],
): RuntimeTaskSessionSummary {
	const result = reduceSessionTransition(summary, event);
	expect(result.changed).toBe(true);
	return { ...summary, ...result.patch };
}

function interaction(summary: RuntimeTaskSessionSummary): RuntimeTaskOutstandingInteraction {
	expect(summary.outstandingInteraction).not.toBeNull();
	return summary.outstandingInteraction as RuntimeTaskOutstandingInteraction;
}

describe("provider interaction lifecycle", () => {
	it("correlates Pi permission decisions by exact tool call id", () => {
		const waiting = apply(
			running("pi"),
			providerHook("to_review", {
				source: "pi",
				hookEventName: "PermissionRequest",
				turnId: "run-1",
				toolUseId: "tool-1",
				toolName: "write",
			}),
		);
		expect(interaction(waiting)).toMatchObject({ provider: "pi", status: "waiting", toolUseId: "tool-1" });

		const unrelated = reduceSessionTransition(
			waiting,
			providerHook("to_in_progress", {
				source: "pi",
				hookEventName: "PermissionResolved",
				turnId: "run-1",
				toolUseId: "tool-2",
				toolName: "write",
			}),
		);
		expect(unrelated.changed).toBe(false);

		const resumed = apply(
			waiting,
			providerHook("to_in_progress", {
				source: "pi",
				hookEventName: "PermissionResolved",
				turnId: "run-1",
				toolUseId: "tool-1",
				toolName: "write",
			}),
		);
		expect(resumed).toMatchObject({ state: "running", reviewReason: null, outstandingInteraction: null });
		expect(resumed.nativeWorkEvidence).toMatchObject({
			provider: "pi",
			sessionInstanceId: "process-1",
			providerSessionId: "session-1",
			turnId: "run-1",
			hookEventName: "PermissionResolved",
		});
	});

	it("keeps denied Pi project trust as an actionable error", () => {
		const waiting = apply(
			running("pi"),
			providerHook("to_review", {
				source: "pi",
				hookEventName: "ProjectTrustRequest",
				toolUseId: "trust-1",
				toolName: "project_trust",
			}),
		);
		const denied = apply(
			waiting,
			providerHook("to_review", {
				source: "pi",
				hookEventName: "ProjectTrustDenied",
				toolUseId: "trust-1",
				toolName: "project_trust",
			}),
		);

		expect(denied).toMatchObject({ state: "awaiting_review", reviewReason: "error", outstandingInteraction: null });
	});

	it("keeps accepted Pi project trust quiet until native work begins", () => {
		const waiting = apply(
			running("pi"),
			providerHook("to_review", {
				source: "pi",
				hookEventName: "ProjectTrustRequest",
				toolUseId: "trust-1",
				toolName: "project_trust",
			}),
		);
		const accepted = apply(
			waiting,
			providerHook("activity", {
				source: "pi",
				hookEventName: "ProjectTrustResolved",
				toolUseId: "trust-1",
				toolName: "project_trust",
			}),
		);

		expect(accepted).toMatchObject({
			state: "awaiting_review",
			reviewReason: "unconfirmed",
			outstandingInteraction: null,
			nativeWorkEvidence: null,
		});
	});

	it("keeps an accepted Codex response pending until the matching native tool completion", () => {
		const waiting = apply(
			running("codex"),
			providerHook("to_review", {
				source: "codex",
				hookEventName: "PermissionRequest",
				turnId: "turn-1",
				toolUseId: "tool-1",
				toolName: "Bash",
			}),
		);
		expect(interaction(waiting)).toMatchObject({ kind: "permission", status: "waiting", toolUseId: "tool-1" });
		expect(deriveTaskIndicatorState(waiting).kind).toBe("approval_required");

		const pending = apply(waiting, {
			type: "interaction.response_submitted",
			responseKind: "submit",
			occurredAt: 110,
		});
		expect(interaction(pending)).toMatchObject({ status: "response_submitted", responseKind: "submit" });
		expect(deriveTaskIndicatorState(pending)).toMatchObject({ kind: "response_pending", needsInput: false });

		const unrelated = reduceSessionTransition(
			pending,
			providerHook(
				"to_in_progress",
				{
					source: "codex",
					hookEventName: "PostToolUse",
					turnId: "turn-1",
					toolUseId: "tool-2",
					toolName: "Read",
				},
				{ occurredAt: 100 },
			),
		);
		expect(unrelated.changed).toBe(false);
		const simultaneousToolStart = reduceSessionTransition(
			pending,
			providerHook(
				"activity",
				{
					source: "codex",
					hookEventName: "PreToolUse",
					turnId: "turn-1",
					toolUseId: "tool-2",
					toolName: "Read",
				},
				{ occurredAt: 110 },
			),
		);
		expect(simultaneousToolStart.changed).toBe(false);
		const laterWork = apply(
			pending,
			providerHook(
				"activity",
				{
					source: "codex",
					hookEventName: "PreToolUse",
					turnId: "turn-1",
					toolUseId: "tool-2",
					toolName: "Read",
				},
				{ occurredAt: 120 },
			),
		);
		expect(laterWork).toMatchObject({ state: "running", reviewReason: null, outstandingInteraction: null });

		const resumed = apply(
			pending,
			providerHook(
				"to_in_progress",
				{
					source: "codex",
					hookEventName: "PostToolUse",
					turnId: "turn-1",
					toolUseId: "tool-1",
					toolName: "Bash",
				},
				{ occurredAt: 120 },
			),
		);
		expect(resumed).toMatchObject({ state: "running", reviewReason: null, outstandingInteraction: null });
	});

	it("treats auto-review PermissionRequest as provisional until an approval is actually rendered", () => {
		const working = running("codex");
		const provisional = reduceSessionTransition(working, {
			...providerHook(
				"to_review",
				{
					source: "codex",
					hookEventName: "PermissionRequest",
					turnId: "turn-1",
					toolName: "Bash",
				},
				{ occurredAt: 100 },
			),
			codexAutoReviewPermissionRequest: true,
		});
		expect(provisional).toMatchObject({
			changed: false,
			hookMetadataMode: "identity_only",
			hookOrderingMode: "advance",
		});

		const rendered = apply(working, { type: "agent.permission-prompt", occurredAt: 110 });
		expect(rendered).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			outstandingInteraction: {
				provider: "codex",
				kind: "permission",
				status: "waiting",
				requestEventName: "RenderedApprovalOverlay",
			},
		});
	});

	it("lets a newer foreground Codex lifecycle supersede an obsolete permission wait", () => {
		const waiting = apply(
			running("codex"),
			providerHook(
				"to_review",
				{
					source: "codex",
					hookEventName: "PermissionRequest",
					turnId: "turn-1",
					toolUseId: "tool-1",
					toolName: "Bash",
				},
				{ occurredAt: 100 },
			),
		);

		const sameTurnParallelWork = reduceSessionTransition(
			waiting,
			providerHook(
				"activity",
				{
					source: "codex",
					hookEventName: "PreToolUse",
					turnId: "turn-1",
					toolUseId: "parallel-tool",
					toolName: "Read",
				},
				{ occurredAt: 120 },
			),
		);
		expect(sameTurnParallelWork.changed).toBe(false);

		const nextTurnWork = apply(
			waiting,
			providerHook(
				"activity",
				{
					source: "codex",
					hookEventName: "PreToolUse",
					turnId: "turn-2",
					toolUseId: "tool-2",
					toolName: "Read",
				},
				{ occurredAt: 120 },
			),
		);
		expect(nextTurnWork).toMatchObject({ state: "running", reviewReason: null, outstandingInteraction: null });
	});

	it("uses a current foreground tool start as work evidence when UserPromptSubmit is missing", () => {
		const review = apply(
			running("codex"),
			providerHook("to_review", { source: "codex", hookEventName: "Stop", turnId: "turn-1" }),
		);
		const genericActivity = reduceSessionTransition(
			review,
			providerHook(
				"activity",
				{ source: "codex", hookEventName: "SessionStart", turnId: "turn-2" },
				{ occurredAt: 120 },
			),
		);
		expect(genericActivity.changed).toBe(false);

		const working = apply(
			review,
			providerHook(
				"activity",
				{
					source: "codex",
					hookEventName: "PreToolUse",
					turnId: "turn-2",
					toolUseId: "tool-2",
					toolName: "Read",
				},
				{ occurredAt: 120 },
			),
		);
		expect(working).toMatchObject({ state: "running", reviewReason: null, outstandingInteraction: null });
	});

	it("lets a newer foreground prompt submission supersede an obsolete wait", () => {
		const waiting = apply(
			running("claude"),
			providerHook(
				"to_review",
				{
					source: "claude",
					hookEventName: "PermissionRequest",
					promptId: "prompt-1",
					toolUseId: "tool-1",
					toolName: "Bash",
				},
				{ occurredAt: 100 },
			),
		);
		const nextPrompt = apply(
			waiting,
			providerHook(
				"to_in_progress",
				{ source: "claude", hookEventName: "UserPromptSubmit", promptId: "prompt-2" },
				{ occurredAt: 120 },
			),
		);

		expect(nextPrompt).toMatchObject({ state: "running", reviewReason: null, outstandingInteraction: null });
	});

	it("keeps a hookless Codex Escape cancellation pending and makes process loss explicit", () => {
		const waiting = apply(running("codex"), { type: "agent.permission-prompt", occurredAt: 100 });
		const pending = apply(waiting, {
			type: "interaction.response_submitted",
			responseKind: "cancel",
			occurredAt: 110,
		});
		const exited = apply(pending, { type: "process.exit", exitCode: 1, interrupted: false });

		expect(exited).toMatchObject({ state: "awaiting_review", reviewReason: "error", pid: null });
		expect(interaction(exited).status).toBe("resolution_unknown");
		expect(deriveTaskIndicatorState(exited)).toMatchObject({ kind: "interaction_unknown", failure: true });
	});

	it("does not let unrelated native activity clear an untouched hookless Codex overlay", () => {
		const waiting = apply(running("codex"), { type: "agent.permission-prompt", occurredAt: 100 });
		const unrelatedCompletion = reduceSessionTransition(
			waiting,
			providerHook(
				"to_in_progress",
				{
					source: "codex",
					hookEventName: "PostToolUse",
					turnId: "turn-1",
					toolUseId: "parallel-tool",
					toolName: "Read",
				},
				{ occurredAt: 110 },
			),
		);
		expect(unrelatedCompletion.changed).toBe(false);

		const unscopedStop = apply(
			waiting,
			providerHook("to_review", { source: "codex", hookEventName: "Stop" }, { occurredAt: 110 }),
		);
		expect(unscopedStop).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			outstandingInteraction: null,
		});

		const pending = apply(waiting, {
			type: "interaction.response_submitted",
			responseKind: "submit",
			occurredAt: 120,
		});
		const resumed = apply(
			pending,
			providerHook(
				"to_in_progress",
				{
					source: "codex",
					hookEventName: "PostToolUse",
					turnId: "turn-1",
					toolUseId: "approved-tool",
					toolName: "Bash",
				},
				{ occurredAt: 130 },
			),
		);
		expect(resumed.state).toBe("running");
	});

	it("correlates Claude permission completion by tool identity and treats denial as pending", () => {
		const waiting = apply(
			running("claude"),
			providerHook(
				"to_review",
				{
					source: "claude",
					hookEventName: "PermissionRequest",
					promptId: "prompt-1",
					toolName: "Bash",
				},
				{ correlatedToolUseId: "tool-1" },
			),
		);

		const denied = apply(
			waiting,
			providerHook("activity", {
				source: "claude",
				hookEventName: "PermissionDenied",
				promptId: "prompt-1",
				toolUseId: "tool-1",
				toolName: "Bash",
			}),
		);
		expect(interaction(denied)).toMatchObject({ status: "response_submitted", responseKind: "provider_denied" });

		const staleDenial = reduceSessionTransition(
			waiting,
			providerHook("activity", {
				source: "claude",
				hookEventName: "PermissionDenied",
				promptId: "prompt-1",
				toolUseId: "tool-2",
				toolName: "Bash",
			}),
		);
		expect(staleDenial.changed).toBe(false);

		const resumed = apply(
			denied,
			providerHook(
				"activity",
				{
					source: "claude",
					hookEventName: "PreToolUse",
					promptId: "prompt-1",
					toolUseId: "tool-2",
					toolName: "Read",
				},
				{ occurredAt: 120 },
			),
		);
		expect(resumed.state).toBe("running");
	});

	it("correlates a delayed Claude PreToolUse without claiming resumed work", () => {
		const waiting = apply(
			running("claude"),
			providerHook(
				"to_review",
				{
					source: "claude",
					hookEventName: "PermissionRequest",
					promptId: "prompt-1",
					toolName: "Bash",
				},
				{ occurredAt: 200 },
			),
		);
		expect(interaction(waiting).toolUseId).toBeNull();

		const correlated = apply(
			waiting,
			providerHook(
				"activity",
				{
					source: "claude",
					hookEventName: "PreToolUse",
					promptId: "prompt-1",
					toolUseId: "tool-1",
					toolName: "Bash",
				},
				{ occurredAt: 100 },
			),
		);
		expect(correlated.state).toBe("awaiting_review");
		expect(interaction(correlated)).toMatchObject({ status: "waiting", toolUseId: "tool-1" });

		const pending = apply(correlated, {
			type: "interaction.response_submitted",
			responseKind: "submit",
			occurredAt: 210,
		});
		const resumed = apply(
			pending,
			providerHook(
				"to_in_progress",
				{
					source: "claude",
					hookEventName: "PostToolUse",
					promptId: "prompt-1",
					toolUseId: "tool-1",
					toolName: "Bash",
				},
				{ occurredAt: 300 },
			),
		);
		expect(resumed.state).toBe("running");
	});

	it("treats a later Claude permission in the same prompt as a new wait", () => {
		const first = apply(
			running("claude"),
			providerHook(
				"to_review",
				{
					source: "claude",
					hookEventName: "PermissionRequest",
					promptId: "prompt-1",
					toolName: "Bash",
				},
				{ occurredAt: 100, correlatedToolUseId: "tool-1" },
			),
		);
		const firstAnswered = apply(first, {
			type: "interaction.response_submitted",
			responseKind: "submit",
			occurredAt: 110,
		});
		const second = apply(
			firstAnswered,
			providerHook(
				"to_review",
				{
					source: "claude",
					hookEventName: "PermissionRequest",
					promptId: "prompt-1",
					toolName: "Bash",
				},
				{ occurredAt: 120 },
			),
		);

		expect(interaction(second)).toMatchObject({
			status: "waiting",
			openedAt: 120,
			toolUseId: null,
		});
		const correlatedSecond = apply(
			second,
			providerHook(
				"activity",
				{
					source: "claude",
					hookEventName: "PreToolUse",
					promptId: "prompt-1",
					toolUseId: "tool-2",
					toolName: "Bash",
				},
				{ occurredAt: 115 },
			),
		);
		expect(interaction(correlatedSecond)).toMatchObject({ status: "waiting", toolUseId: "tool-2" });
	});

	it("rejects delayed completion evidence that predates the submitted response", () => {
		const waiting = apply(
			running("codex"),
			providerHook(
				"to_review",
				{
					source: "codex",
					hookEventName: "PermissionRequest",
					turnId: "turn-1",
					toolUseId: "tool-1",
					toolName: "Bash",
				},
				{ occurredAt: 100 },
			),
		);
		const pending = apply(waiting, {
			type: "interaction.response_submitted",
			responseKind: "submit",
			occurredAt: 200,
		});

		const delayed = reduceSessionTransition(
			pending,
			providerHook(
				"to_in_progress",
				{
					source: "codex",
					hookEventName: "PostToolUse",
					turnId: "turn-1",
					toolUseId: "tool-1",
					toolName: "Bash",
				},
				{ occurredAt: 150 },
			),
		);
		expect(delayed.changed).toBe(false);

		const current = apply(
			pending,
			providerHook(
				"to_in_progress",
				{
					source: "codex",
					hookEventName: "PostToolUse",
					turnId: "turn-1",
					toolUseId: "tool-1",
					toolName: "Bash",
				},
				{ occurredAt: 250 },
			),
		);
		expect(current.state).toBe("running");
	});

	it("requires a Stop hook to carry the outstanding interaction's prompt identity", () => {
		const waiting = apply(
			running("claude"),
			providerHook("activity", {
				source: "claude",
				hookEventName: "PreToolUse",
				promptId: "prompt-1",
				toolUseId: "tool-1",
				toolName: "AskUserQuestion",
			}),
		);
		const staleStop = reduceSessionTransition(
			waiting,
			providerHook("to_review", {
				source: "claude",
				hookEventName: "Stop",
				promptId: "prompt-2",
			}),
		);
		expect(staleStop.changed).toBe(false);

		const currentStop = apply(
			waiting,
			providerHook("to_review", {
				source: "claude",
				hookEventName: "Stop",
				promptId: "prompt-1",
			}),
		);
		expect(currentStop).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			outstandingInteraction: null,
		});
	});

	it("lets a later current root Stop retire a wait even when interaction identity is unavailable", () => {
		const waiting = apply(
			running("claude"),
			providerHook(
				"to_review",
				{
					source: "claude",
					hookEventName: "PermissionRequest",
					promptId: "prompt-1",
					toolName: "Bash",
				},
				{ occurredAt: 100 },
			),
		);
		const completed = apply(
			waiting,
			providerHook("to_review", { source: "claude", hookEventName: "Stop" }, { occurredAt: 120 }),
		);

		expect(completed).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			outstandingInteraction: null,
		});
	});

	it.each([
		["AskUserQuestion", "question"],
		["ExitPlanMode", "plan_approval"],
	] as const)("tracks Claude %s as a typed wait until its exact PostToolUse", (toolName, kind) => {
		const waiting = apply(
			running("claude"),
			providerHook("activity", {
				source: "claude",
				hookEventName: "PreToolUse",
				promptId: "prompt-1",
				toolUseId: "tool-1",
				toolName,
			}),
		);
		expect(interaction(waiting)).toMatchObject({ kind, status: "waiting", toolUseId: "tool-1" });
		const pending = apply(waiting, {
			type: "interaction.response_submitted",
			responseKind: "cancel",
			occurredAt: 110,
		});
		expect(interaction(pending)).toMatchObject({ status: "response_submitted", responseKind: "cancel" });
		expect(deriveTaskIndicatorState(pending)).toMatchObject({ kind: "response_pending", needsInput: false });

		const wrong = reduceSessionTransition(
			pending,
			providerHook(
				"to_in_progress",
				{
					source: "claude",
					hookEventName: "PostToolUse",
					promptId: "prompt-1",
					toolUseId: "tool-2",
					toolName,
				},
				{ occurredAt: 120 },
			),
		);
		expect(wrong.changed).toBe(false);

		const resumed = apply(
			pending,
			providerHook(
				"to_in_progress",
				{
					source: "claude",
					hookEventName: "PostToolUse",
					promptId: "prompt-1",
					toolUseId: "tool-1",
					toolName,
				},
				{ occurredAt: 120 },
			),
		);
		expect(resumed.state).toBe("running");
	});

	it("tracks Elicitation through its identity-bearing native result", () => {
		const elicitation = apply(
			running("claude"),
			providerHook("to_review", {
				source: "claude",
				hookEventName: "Elicitation",
				promptId: "prompt-1",
				elicitationId: "elicitation-1",
			}),
		);
		expect(interaction(elicitation).kind).toBe("elicitation");
		const pending = apply(elicitation, {
			type: "interaction.response_submitted",
			responseKind: "submit",
			occurredAt: 110,
		});
		expect(deriveTaskIndicatorState(pending)).toMatchObject({ kind: "response_pending", needsInput: false });
		const afterElicitation = apply(
			pending,
			providerHook(
				"to_in_progress",
				{
					source: "claude",
					hookEventName: "ElicitationResult",
					promptId: "prompt-1",
					elicitationId: "elicitation-1",
				},
				{ occurredAt: 120 },
			),
		);
		expect(afterElicitation.state).toBe("running");
	});

	it("requires a submitted response and prompt scope when ElicitationResult omits identity", () => {
		const waiting = apply(
			running("claude"),
			providerHook("to_review", {
				source: "claude",
				hookEventName: "Elicitation",
				promptId: "prompt-1",
			}),
		);
		const untouchedResult = reduceSessionTransition(
			waiting,
			providerHook(
				"to_in_progress",
				{ source: "claude", hookEventName: "ElicitationResult", promptId: "prompt-1" },
				{ occurredAt: 110 },
			),
		);
		expect(untouchedResult.changed).toBe(false);

		const pending = apply(waiting, {
			type: "interaction.response_submitted",
			responseKind: "submit",
			occurredAt: 120,
		});
		const unscoped = reduceSessionTransition(
			pending,
			providerHook("to_in_progress", { source: "claude", hookEventName: "ElicitationResult" }, { occurredAt: 130 }),
		);
		expect(unscoped.changed).toBe(false);
		const scoped = apply(
			pending,
			providerHook(
				"to_in_progress",
				{ source: "claude", hookEventName: "ElicitationResult", promptId: "prompt-1" },
				{ occurredAt: 130 },
			),
		);
		expect(scoped.state).toBe("running");
	});

	it("does not attribute legacy Claude background notifications to the current task", () => {
		const runningSummary = running("claude");
		const needsInput = reduceSessionTransition(
			runningSummary,
			providerHook("to_review", {
				source: "claude",
				hookEventName: "Notification",
				notificationType: "agent_needs_input",
				promptId: "prompt-1",
				providerAgentId: "agent-1",
			}),
		);
		expect(needsInput).toMatchObject({ changed: false, hookMetadataMode: "preserve" });

		const completed = reduceSessionTransition(
			runningSummary,
			providerHook("activity", {
				source: "claude",
				hookEventName: "Notification",
				notificationType: "agent_completed",
				promptId: "prompt-1",
				providerAgentId: "agent-1",
			}),
		);
		expect(completed).toMatchObject({ changed: false, hookMetadataMode: "preserve" });
	});

	it("does not let Claude subagent hooks author or resolve the foreground interaction", () => {
		const request = reduceSessionTransition(
			running("claude"),
			providerHook("to_review", {
				source: "claude",
				hookEventName: "PreToolUse",
				toolName: "AskUserQuestion",
				toolUseId: "subagent-tool-1",
				providerAgentId: "subagent-1",
			}),
		);
		expect(request).toMatchObject({ changed: false, hookMetadataMode: "preserve" });

		const foregroundWaiting = apply(
			running("claude"),
			providerHook(
				"to_review",
				{
					source: "claude",
					hookEventName: "PermissionRequest",
					promptId: "prompt-1",
					toolName: "Bash",
				},
				{ correlatedToolUseId: "foreground-tool-1" },
			),
		);
		const subagentCompletion = reduceSessionTransition(
			foregroundWaiting,
			providerHook("to_in_progress", {
				source: "claude",
				hookEventName: "PostToolUse",
				promptId: "subagent-prompt-1",
				toolUseId: "subagent-tool-1",
				providerAgentId: "subagent-1",
			}),
		);
		expect(subagentCompletion).toMatchObject({ changed: false, hookMetadataMode: "preserve" });
	});

	it("rejects provider lifecycle claims without current launch evidence", () => {
		const result = reduceSessionTransition(running("claude"), {
			...providerHook("to_review", {
				source: "claude",
				hookEventName: "PermissionRequest",
				promptId: "prompt-1",
				toolName: "Bash",
			}),
			sessionEvidence: "unconfirmed",
		});
		expect(result).toMatchObject({ changed: false, patch: {}, hookMetadataMode: "preserve" });
	});
});
