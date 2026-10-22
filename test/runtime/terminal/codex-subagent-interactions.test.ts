import { describe, expect, it } from "vitest";

import type { RuntimeHookEvent, RuntimeHookMetadata, RuntimeTaskSessionSummary } from "../../../src/core";
import { deriveTaskIndicatorState, normalizeRuntimeTaskSessionSummary } from "../../../src/core";
import type { SessionTransitionEvent } from "../../../src/terminal/session-state-machine";
import { InMemorySessionSummaryStore } from "../../../src/terminal/session-summary-store";
import {
	createTestProviderHookEvent,
	createTestTaskNativeWorkEvidence,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

const TASK_ID = "task-1";
const LAUNCH = "process-1";
const ROOT_SESSION = "root-session";

type ProviderHookEvent = Extract<SessionTransitionEvent, { type: "provider.hook" }>;

function runningCodex(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId: TASK_ID,
		state: "running",
		agentId: "codex",
		sessionInstanceId: LAUNCH,
		resumeSessionId: ROOT_SESSION,
		pid: 123,
		nativeWorkEvidence: createTestTaskNativeWorkEvidence({
			provider: "codex",
			sessionInstanceId: LAUNCH,
			turnId: "root-turn",
			promptId: null,
			hookEventName: "UserPromptSubmit",
			confirmedAt: 50,
		}),
		...overrides,
	});
}

function createStore(summary: RuntimeTaskSessionSummary = runningCodex()): InMemorySessionSummaryStore {
	const store = new InMemorySessionSummaryStore();
	store.ensureEntry(summary.taskId);
	store.update(summary.taskId, summary);
	return store;
}

function codexHook(
	event: RuntimeHookEvent,
	hookEventName: string,
	occurredAt: number,
	metadata: Omit<RuntimeHookMetadata, "source" | "hookEventName"> = {},
	options: { correlatedToolUseId?: string | null; renderedPromptRequired?: boolean } = {},
): ProviderHookEvent {
	return {
		...createTestProviderHookEvent(event, {
			source: "codex",
			hookEventName,
			occurredAt,
			metadata: { sessionInstanceId: LAUNCH, sessionId: ROOT_SESSION, turnId: "root-turn", ...metadata },
			correlatedToolUseId: options.correlatedToolUseId ?? null,
		}),
		codexPermissionRequiresRenderedPrompt: options.renderedPromptRequired ?? false,
	};
}

function childHook(
	event: RuntimeHookEvent,
	hookEventName: string,
	occurredAt: number,
	metadata: Omit<RuntimeHookMetadata, "source" | "hookEventName"> = {},
	options: { correlatedToolUseId?: string | null; renderedPromptRequired?: boolean } = {},
): ProviderHookEvent {
	return codexHook(
		event,
		hookEventName,
		occurredAt,
		{ providerAgentId: "child-a", turnId: "child-turn-1", toolName: "Bash", ...metadata },
		options,
	);
}

function childPermission(occurredAt: number, toolUseId: string | null, renderedPromptRequired = false) {
	return childHook(
		"to_review",
		"PermissionRequest",
		occurredAt,
		{},
		{ correlatedToolUseId: toolUseId, renderedPromptRequired },
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

describe("Codex subagent interactions", () => {
	it("opens a keyed Needs Input wait for a user-reviewed subagent approval", () => {
		const store = createStore();
		const before = summaryOf(store);
		apply(store, childHook("activity", "PreToolUse", 100, { toolUseId: "child-call-1" }));

		const opened = apply(store, childPermission(110, "child-call-1"));

		expect(opened).toMatchObject({ changed: true, hookMetadataMode: "preserve", hookOrderingMode: "advance" });
		const summary = summaryOf(store);
		expect(summary).toMatchObject({
			state: "running",
			outstandingInteraction: null,
			nativeWorkEvidence: before.nativeWorkEvidence,
			latestHookActivity: before.latestHookActivity,
			resumeSessionId: ROOT_SESSION,
		});
		expect(summary.subagentInteractions).toEqual([
			expect.objectContaining({
				provider: "codex",
				kind: "permission",
				status: "waiting",
				providerAgentId: "child-a",
				turnId: "child-turn-1",
				toolUseId: "child-call-1",
			}),
		]);
		expect(deriveTaskIndicatorState(summary)).toMatchObject({ kind: "approval_required", needsInput: true });
	});

	it("keeps an inherited or automatic reviewer request ordering-only", () => {
		const store = createStore();

		const result = apply(store, childPermission(110, null, true));

		expect(result).toMatchObject({ changed: false, hookMetadataMode: "preserve", hookOrderingMode: "advance" });
		expect(summaryOf(store).subagentInteractions ?? []).toEqual([]);
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("running");
	});

	it("resolves only on the same subagent's matching completion", () => {
		const store = createStore();
		apply(store, childPermission(110, "child-call-1"));

		// Root work, another subagent, and a different tool of the same child do not answer it.
		apply(store, codexHook("to_in_progress", "PostToolUse", 120, { toolUseId: "root-call", toolName: "Bash" }));
		apply(store, childHook("to_in_progress", "PostToolUse", 121, { providerAgentId: "child-b", toolUseId: "b-1" }));
		// A sibling tool that started before the request completes.
		apply(store, childHook("to_in_progress", "PostToolUse", 123, { toolUseId: "child-call-0" }));
		expect(summaryOf(store).state).toBe("running");
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");

		apply(store, childHook("to_in_progress", "PostToolUse", 130, { toolUseId: "child-call-1" }));

		expect(summaryOf(store).subagentInteractions).toEqual([]);
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("running");
	});

	it("retires a wait when the same subagent starts a later turn", () => {
		const store = createStore();
		apply(store, childPermission(110, "child-call-1"));

		apply(store, childHook("to_in_progress", "UserPromptSubmit", 150, { turnId: "child-turn-2" }));

		expect(summaryOf(store).subagentInteractions).toEqual([]);
	});

	it("retires an answered wait on the subagent's next tool after a hookless denial", () => {
		const store = createStore();
		apply(store, childPermission(110, "child-call-1"));
		apply(store, { type: "interaction.response_submitted", responseKind: "cancel", occurredAt: 120 });
		expect(summaryOf(store).subagentInteractions?.[0]).toMatchObject({ status: "response_submitted" });
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("running");

		apply(store, childHook("activity", "PreToolUse", 130, { toolUseId: "child-call-2" }));

		expect(summaryOf(store).subagentInteractions).toEqual([]);
	});

	it("retires an unanswered wait when the subagent starts a later tool", () => {
		// Denial through an unrecognized key emits no hook; the next tool proves it.
		const store = createStore();
		apply(store, childPermission(110, "child-call-1"));
		apply(store, childHook("activity", "PreToolUse", 130, { providerAgentId: "child-b", toolUseId: "b-2" }));
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");

		apply(store, childHook("activity", "PreToolUse", 130, { toolUseId: "child-call-2" }));

		expect(summaryOf(store).subagentInteractions).toEqual([]);
	});

	it("keeps the subagent wait through a root Stop and a root Interrupt", () => {
		const store = createStore();
		apply(store, childPermission(110, "child-call-1"));

		apply(store, codexHook("to_review", "Stop", 200));
		expect(summaryOf(store)).toMatchObject({ state: "awaiting_review" });
		expect(deriveTaskIndicatorState(summaryOf(store))).toMatchObject({ kind: "approval_required", needsInput: true });

		apply(store, codexHook("to_in_progress", "UserPromptSubmit", 300, { turnId: "root-turn-2" }));
		apply(store, codexHook("to_review", "Interrupt", 310, { turnId: "root-turn-2" }));
		expect(summaryOf(store)).toMatchObject({ state: "awaiting_review", reviewReason: "interrupted" });
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");
	});

	it("opens a subagent wait after the root turn completed", () => {
		const store = createStore(
			runningCodex({ state: "awaiting_review", reviewReason: "hook", nativeWorkEvidence: null }),
		);

		apply(store, childPermission(110, null));

		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");
	});

	it("retires subagent waits on foreground navigation, process exit, and cold hydration", () => {
		const navigated = createStore();
		apply(navigated, childPermission(110, null));
		apply(
			navigated,
			codexHook("activity", "SessionStart", 200, {
				sessionId: "new-root",
				sessionStartSource: "clear",
				turnId: null,
			}),
		);
		expect(summaryOf(navigated)).toMatchObject({ state: "awaiting_review", subagentInteractions: [] });

		const exited = createStore();
		apply(exited, childPermission(110, null));
		exited.update(TASK_ID, { pid: null });
		expect(summaryOf(exited).subagentInteractions).toEqual([]);

		const hydrated = createStore();
		apply(hydrated, childPermission(110, null));
		expect(
			normalizeRuntimeTaskSessionSummary(summaryOf(hydrated), { invalidateNativeWorkEvidence: true })
				.subagentInteractions,
		).toEqual([]);
	});

	it("does not let a labelled overlay duplicate a native subagent wait but detects a foreground overlay", () => {
		const store = createStore();
		apply(store, childPermission(110, "child-call-1"));

		const labelled = apply(store, { type: "agent.permission-prompt", occurredAt: 111, threadLabeled: true });
		expect(labelled.changed).toBe(false);
		expect(summaryOf(store).outstandingInteraction).toBeNull();

		// A hookless foreground approval replaces the subagent overlay.
		const foreground = apply(store, { type: "agent.permission-prompt", occurredAt: 120, threadLabeled: false });
		expect(foreground.changed).toBe(true);
		expect(summaryOf(store)).toMatchObject({
			state: "awaiting_review",
			outstandingInteraction: expect.objectContaining({ requestEventName: "RenderedApprovalOverlay" }),
		});
	});

	it("ignores replayed subagent requests", () => {
		const store = createStore();
		for (const sessionEvidence of ["startup_replay", "exited_replay"] as const) {
			apply(store, { ...childPermission(110, null), sessionEvidence });
		}
		expect(summaryOf(store).subagentInteractions ?? []).toEqual([]);
	});
});
