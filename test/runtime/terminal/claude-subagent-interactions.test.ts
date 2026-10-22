import { describe, expect, it } from "vitest";

import type { RuntimeHookEvent, RuntimeHookMetadata, RuntimeTaskSessionSummary } from "../../../src/core";
import {
	deriveTaskIndicatorState,
	getRuntimeSessionWorkColumn,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core";
import { taskNotificationEventIdentity } from "../../../src/shared/task-notification-policy";
import {
	canApplyClaudeRenderedTurnInterruption,
	type SessionTransitionEvent,
} from "../../../src/terminal/session-state-machine";
import { InMemorySessionSummaryStore } from "../../../src/terminal/session-summary-store";
import { resolveInteractionResponseTarget } from "../../../src/terminal/subagent-interactions";
import {
	createTestProviderHookEvent,
	createTestTaskNativeWorkEvidence,
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

const TASK_ID = "task-1";
const LAUNCH = "process-1";

function runningClaude(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId: TASK_ID,
		state: "running",
		agentId: "claude",
		sessionInstanceId: LAUNCH,
		resumeSessionId: "session-1",
		pid: 123,
		nativeWorkEvidence: createTestTaskNativeWorkEvidence({
			provider: "claude",
			sessionInstanceId: LAUNCH,
			turnId: null,
			promptId: "prompt-1",
			hookEventName: "UserPromptSubmit",
			confirmedAt: 50,
		}),
		...overrides,
	});
}

function createStore(summary: RuntimeTaskSessionSummary = runningClaude()): InMemorySessionSummaryStore {
	const store = new InMemorySessionSummaryStore();
	store.ensureEntry(summary.taskId);
	store.update(summary.taskId, summary);
	return store;
}

function claudeHook(
	event: RuntimeHookEvent,
	hookEventName: string,
	occurredAt: number,
	metadata: Omit<RuntimeHookMetadata, "source" | "hookEventName"> = {},
	options: {
		correlatedToolUseId?: string | null;
		sessionEvidence?: Extract<SessionTransitionEvent, { type: "provider.hook" }>["sessionEvidence"];
	} = {},
): Extract<SessionTransitionEvent, { type: "provider.hook" }> {
	return createTestProviderHookEvent(event, {
		source: "claude",
		hookEventName,
		occurredAt,
		metadata: { sessionInstanceId: LAUNCH, sessionId: "session-1", promptId: "prompt-1", ...metadata },
		...options,
	});
}

function subagentPermissionRequest(agentId: string, occurredAt: number, toolUseId: string | null) {
	return claudeHook(
		"to_review",
		"PermissionRequest",
		occurredAt,
		{ providerAgentId: agentId, toolName: "Bash" },
		{ correlatedToolUseId: toolUseId },
	);
}

function apply(store: InMemorySessionSummaryStore, event: SessionTransitionEvent) {
	const result = store.applySessionEvent(TASK_ID, event);
	if (!result) throw new Error("Expected the test task to exist.");
	return result;
}

function summaryOf(store: InMemorySessionSummaryStore): RuntimeTaskSessionSummary {
	const summary = store.getSummary(TASK_ID);
	if (!summary) throw new Error("Expected the test task to exist.");
	return summary;
}

describe("Claude subagent interactions", () => {
	it("opens a keyed Needs Input wait without changing the foreground lifecycle", () => {
		const store = createStore();
		const before = summaryOf(store);
		expect(
			apply(
				store,
				claudeHook("to_in_progress", "PreToolUse", 100, { providerAgentId: "agent-a", toolUseId: "a-1" }),
			),
		).toMatchObject({ changed: false, hookMetadataMode: "preserve", hookOrderingMode: "advance" });

		const opened = apply(store, subagentPermissionRequest("agent-a", 110, "a-1"));

		expect(opened).toMatchObject({ changed: true, hookMetadataMode: "preserve", hookOrderingMode: "advance" });
		const summary = summaryOf(store);
		expect(summary).toMatchObject({
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
			nativeWorkEvidence: before.nativeWorkEvidence,
			latestHookActivity: before.latestHookActivity,
		});
		expect(summary.subagentInteractions).toEqual([
			expect.objectContaining({
				provider: "claude",
				kind: "permission",
				status: "waiting",
				providerAgentId: "agent-a",
				toolUseId: "a-1",
				toolName: "Bash",
				openedAt: 110,
			}),
		]);
		expect(deriveTaskIndicatorState(summary)).toMatchObject({
			kind: "approval_required",
			publicStatus: "needs_input",
			notification: "permission",
			needsInput: true,
			approvalRequired: true,
		});
		expect(getRuntimeSessionWorkColumn(summary)).toBe("review");
		// Escape on the subagent dialog still arms Claude's rendered-interrupt detector.
		expect(canApplyClaudeRenderedTurnInterruption(summary)).toBe(true);
	});

	it("keeps the wait across other subagents and main-agent work until its own subagent progresses", () => {
		const store = createStore();
		apply(store, subagentPermissionRequest("agent-a", 110, "a-1"));

		apply(store, claudeHook("to_in_progress", "PreToolUse", 120, { providerAgentId: "agent-b", toolUseId: "b-1" }));
		apply(store, claudeHook("to_in_progress", "PostToolUse", 130, { providerAgentId: "agent-b", toolUseId: "b-1" }));
		apply(store, claudeHook("activity", "SubagentStop", 131, { providerAgentId: "agent-b" }));
		const mainWork = apply(store, claudeHook("to_in_progress", "PreToolUse", 140, { toolUseId: "main-1" }));
		expect(mainWork.changed).toBe(true);
		expect(summaryOf(store)).toMatchObject({
			state: "running",
			nativeWorkEvidence: expect.objectContaining({ hookEventName: "PreToolUse", confirmedAt: 140 }),
		});
		// A parallel tool from the waiting subagent is not the permitted tool.
		apply(store, claudeHook("to_in_progress", "PostToolUse", 150, { providerAgentId: "agent-a", toolUseId: "a-0" }));
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");

		apply(store, claudeHook("to_in_progress", "PostToolUse", 160, { providerAgentId: "agent-a", toolUseId: "a-1" }));

		expect(summaryOf(store).subagentInteractions).toEqual([]);
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("running");
	});

	it.each([
		[
			"a later tool start",
			claudeHook("to_in_progress", "PreToolUse", 120, { providerAgentId: "agent-a", toolUseId: "a-2" }),
		],
		["SubagentStop", claudeHook("activity", "SubagentStop", 120, { providerAgentId: "agent-a" })],
		[
			"an automatic denial",
			claudeHook("activity", "PermissionDenied", 120, { providerAgentId: "agent-a", toolUseId: "a-1" }),
		],
		[
			"the permitted tool's failure",
			claudeHook("to_in_progress", "PostToolUseFailure", 120, { providerAgentId: "agent-a", toolUseId: "a-1" }),
		],
	])("clears the wait on %s from the same subagent", (_name, resolution) => {
		const store = createStore();
		apply(store, subagentPermissionRequest("agent-a", 110, "a-1"));
		apply(store, { ...resolution, metadata: { ...resolution.metadata, providerAgentId: "agent-b" } });
		expect(summaryOf(store).subagentInteractions).toHaveLength(1);

		apply(store, resolution);

		expect(summaryOf(store).subagentInteractions).toEqual([]);
		expect(summaryOf(store).state).toBe("running");
	});

	it("enriches an uncorrelated wait from its delayed request and otherwise requires later evidence", () => {
		const store = createStore();
		apply(store, subagentPermissionRequest("agent-a", 110, null));
		apply(store, claudeHook("to_in_progress", "PostToolUse", 105, { providerAgentId: "agent-a", toolUseId: "a-0" }));
		expect(summaryOf(store).subagentInteractions).toHaveLength(1);

		apply(
			store,
			claudeHook("to_in_progress", "PreToolUse", 108, {
				providerAgentId: "agent-a",
				toolUseId: "a-1",
				toolName: "Bash",
			}),
		);
		expect(summaryOf(store).subagentInteractions?.[0]).toMatchObject({ status: "waiting", toolUseId: "a-1" });

		const uncorrelated = createStore();
		apply(uncorrelated, subagentPermissionRequest("agent-a", 110, null));
		apply(
			uncorrelated,
			claudeHook("to_in_progress", "PostToolUse", 120, { providerAgentId: "agent-a", toolUseId: "a-9" }),
		);
		expect(uncorrelated.getSummary(TASK_ID)?.subagentInteractions).toEqual([]);
	});

	it("tracks concurrent subagent waits independently and answers the oldest first", () => {
		const store = createStore();
		apply(store, subagentPermissionRequest("agent-a", 110, "a-1"));
		apply(store, subagentPermissionRequest("agent-b", 120, "b-1"));
		const both = summaryOf(store);
		expect(both.subagentInteractions?.map((interaction) => interaction.providerAgentId)).toEqual([
			"agent-a",
			"agent-b",
		]);
		expect(resolveInteractionResponseTarget(both, null)?.providerAgentId).toBe("agent-a");

		apply(store, { type: "interaction.response_submitted", responseKind: "submit", occurredAt: 130 });
		expect(summaryOf(store).subagentInteractions).toEqual([
			expect.objectContaining({
				providerAgentId: "agent-a",
				status: "response_submitted",
				responseSubmittedAt: 130,
			}),
			expect.objectContaining({ providerAgentId: "agent-b", status: "waiting" }),
		]);
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");

		apply(store, { type: "interaction.response_submitted", responseKind: "cancel", occurredAt: 140 });
		expect(summaryOf(store).subagentInteractions?.[1]).toMatchObject({
			status: "response_submitted",
			responseKind: "cancel",
		});
		// Answered subagent prompts are gone from the TUI; the foreground turn is still Running.
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("running");
		expect(
			apply(store, { type: "interaction.response_submitted", responseKind: "submit", occurredAt: 150 }).changed,
		).toBe(false);

		apply(store, claudeHook("to_in_progress", "PostToolUse", 160, { providerAgentId: "agent-b", toolUseId: "b-1" }));
		expect(summaryOf(store).subagentInteractions?.map((interaction) => interaction.providerAgentId)).toEqual([
			"agent-a",
		]);
	});

	it("replaces a subagent's answered wait with its next prompt", () => {
		const store = createStore();
		apply(store, subagentPermissionRequest("agent-a", 110, "a-1"));
		apply(store, { type: "interaction.response_submitted", responseKind: "submit", occurredAt: 120 });
		apply(store, subagentPermissionRequest("agent-a", 130, "a-2"));

		expect(summaryOf(store).subagentInteractions).toEqual([
			expect.objectContaining({ status: "waiting", toolUseId: "a-2", openedAt: 130 }),
		]);
	});

	it("keeps foreground interaction semantics beside a subagent wait", () => {
		const store = createStore();
		apply(store, subagentPermissionRequest("agent-a", 110, "a-1"));
		apply(
			store,
			claudeHook("to_review", "PermissionRequest", 120, { toolName: "Bash" }, { correlatedToolUseId: "main-1" }),
		);
		expect(summaryOf(store)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			outstandingInteraction: expect.objectContaining({
				status: "waiting",
				toolUseId: "main-1",
				providerAgentId: null,
			}),
			subagentInteractions: [expect.objectContaining({ providerAgentId: "agent-a", status: "waiting" })],
		});

		// Claude shows the older subagent prompt first.
		apply(store, { type: "interaction.response_submitted", responseKind: "submit", occurredAt: 130 });
		expect(summaryOf(store).outstandingInteraction?.status).toBe("waiting");
		expect(summaryOf(store).subagentInteractions?.[0]?.status).toBe("response_submitted");
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");

		apply(store, { type: "interaction.response_submitted", responseKind: "submit", occurredAt: 140 });
		expect(summaryOf(store).outstandingInteraction?.status).toBe("response_submitted");
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("response_pending");

		apply(store, claudeHook("to_in_progress", "PostToolUse", 150, { toolUseId: "main-1" }));
		expect(summaryOf(store)).toMatchObject({ state: "running", outstandingInteraction: null });
		expect(summaryOf(store).subagentInteractions).toHaveLength(1);

		apply(store, claudeHook("to_review", "Stop", 200));
		expect(summaryOf(store)).toMatchObject({ state: "awaiting_review", reviewReason: "hook" });
		expect(summaryOf(store).subagentInteractions).toEqual([]);
	});

	it("answers a newer subagent prompt only after the older foreground prompt", () => {
		const store = createStore();
		apply(
			store,
			claudeHook("to_review", "PermissionRequest", 110, { toolName: "Bash" }, { correlatedToolUseId: "main-1" }),
		);
		apply(store, subagentPermissionRequest("agent-a", 120, "a-1"));

		apply(store, { type: "interaction.response_submitted", responseKind: "submit", occurredAt: 130 });

		expect(summaryOf(store).outstandingInteraction?.status).toBe("response_submitted");
		expect(summaryOf(store).subagentInteractions?.[0]?.status).toBe("waiting");
		// The subagent prompt now owns the dialog even though the foreground answer is unconfirmed.
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");
	});

	it.each<[string, SessionTransitionEvent]>([
		["a rendered Escape interruption", { type: "agent.rendered-turn-interrupted", provider: "claude" }],
		["interrupt recovery", { type: "interrupt.recovery" }],
		["an explicit stop", { type: "user.stop" }],
		["process exit", { type: "process.exit", exitCode: 0, interrupted: false }],
		["a completed root Stop", claudeHook("to_review", "Stop", 200)],
		["a root StopFailure", claudeHook("to_review", "StopFailure", 200)],
	])("retires subagent waits with the foreground turn on %s", (_name, event) => {
		const store = createStore();
		apply(store, subagentPermissionRequest("agent-a", 110, "a-1"));

		apply(store, event);

		expect(summaryOf(store).state).toBe("awaiting_review");
		expect(summaryOf(store).subagentInteractions).toEqual([]);
	});

	it("keeps subagent waits through a root Stop that still waits on background agents", () => {
		const store = createStore();
		apply(store, subagentPermissionRequest("agent-a", 110, "a-1"));

		apply(store, claudeHook("activity", "Stop", 200));

		expect(summaryOf(store).state).toBe("running");
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");
	});

	it("does not let a foreground prompt submission clear a subagent wait", () => {
		const store = createStore();
		apply(store, subagentPermissionRequest("agent-a", 110, "a-1"));

		apply(store, claudeHook("to_in_progress", "UserPromptSubmit", 200, { promptId: "prompt-2" }));

		expect(summaryOf(store).state).toBe("running");
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");
	});

	it("ignores replayed, unconfirmed, and presentation-only subagent hooks", () => {
		const store = createStore();
		for (const sessionEvidence of ["startup_replay", "exited_replay", "unconfirmed"] as const) {
			expect(
				apply(
					store,
					claudeHook("to_review", "PermissionRequest", 110, { providerAgentId: "agent-a" }, { sessionEvidence }),
				),
			).toMatchObject({ changed: false, hookMetadataMode: "preserve" });
		}
		const notification = apply(
			store,
			claudeHook("activity", "Notification", 110, {
				providerAgentId: "agent-a",
				notificationType: "permission_prompt",
			}),
		);
		expect(notification).toEqual({
			changed: false,
			patch: {},
			clearAttentionBuffer: false,
			hookMetadataMode: "preserve",
			summary: expect.anything(),
		});
		expect(summaryOf(store).subagentInteractions ?? []).toEqual([]);
	});

	it("does not open a subagent wait after the foreground turn completed", () => {
		const store = createStore(
			runningClaude({ state: "awaiting_review", reviewReason: "hook", nativeWorkEvidence: null }),
		);

		const result = apply(store, subagentPermissionRequest("agent-a", 110, "a-1"));

		expect(result).toMatchObject({ changed: false, hookOrderingMode: "advance" });
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("review_ready");
	});

	it("tracks a subagent elicitation until its matching result", () => {
		const store = createStore();
		apply(
			store,
			claudeHook("to_review", "Elicitation", 110, { providerAgentId: "agent-a", elicitationId: "elicitation-1" }),
		);
		expect(summaryOf(store).subagentInteractions?.[0]).toMatchObject({
			kind: "elicitation",
			elicitationId: "elicitation-1",
		});
		expect(deriveTaskIndicatorState(summaryOf(store))).toMatchObject({ kind: "needs_input", notification: "review" });

		apply(store, claudeHook("to_in_progress", "PostToolUse", 120, { providerAgentId: "agent-a", toolUseId: "a-1" }));
		apply(
			store,
			claudeHook("to_in_progress", "ElicitationResult", 130, {
				providerAgentId: "agent-a",
				elicitationId: "elicitation-2",
			}),
		);
		expect(summaryOf(store).subagentInteractions).toHaveLength(1);

		apply(
			store,
			claudeHook("to_in_progress", "ElicitationResult", 140, {
				providerAgentId: "agent-a",
				elicitationId: "elicitation-1",
			}),
		);
		expect(summaryOf(store).subagentInteractions).toEqual([]);
	});

	it("round-trips persisted waits, accepts legacy records, and drops waits on cold hydration", () => {
		const waiting = createTestTaskOutstandingInteraction({
			kind: "permission",
			providerAgentId: "agent-a",
			toolUseId: "a-1",
			toolName: "Bash",
			openedAt: 110,
			updatedAt: 110,
		});
		const persisted = runtimeTaskSessionSummarySchema.parse(
			JSON.parse(JSON.stringify(runningClaude({ subagentInteractions: [waiting] }))),
		);
		expect(persisted).toMatchObject({ state: "running", subagentInteractions: [waiting] });
		expect(deriveTaskIndicatorState(persisted).kind).toBe("approval_required");

		const { subagentInteractions, ...legacy } = persisted;
		expect(subagentInteractions).toHaveLength(1);
		const legacyParsed = runtimeTaskSessionSummarySchema.parse(JSON.parse(JSON.stringify(legacy)));
		expect(legacyParsed.subagentInteractions).toBeUndefined();
		expect(deriveTaskIndicatorState(legacyParsed).kind).toBe("running");

		const hydrated = new InMemorySessionSummaryStore();
		hydrated.hydrateFromRecord({ [TASK_ID]: persisted });
		expect(hydrated.getSummary(TASK_ID)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			subagentInteractions: [],
		});
	});

	it("gives successive subagent prompts distinct notification identities", () => {
		const first = runningClaude({
			subagentInteractions: [
				createTestTaskOutstandingInteraction({ kind: "permission", providerAgentId: "agent-a", openedAt: 110 }),
			],
		});
		const second = runningClaude({
			subagentInteractions: [
				createTestTaskOutstandingInteraction({ kind: "permission", providerAgentId: "agent-a", openedAt: 130 }),
			],
		});

		expect(taskNotificationEventIdentity("project-1", first, "permission")).not.toBe(
			taskNotificationEventIdentity("project-1", second, "permission"),
		);
	});
});
