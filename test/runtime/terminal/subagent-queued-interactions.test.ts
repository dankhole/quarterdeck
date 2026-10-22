import { describe, expect, it } from "vitest";

import type { RuntimeHookEvent, RuntimeHookMetadata, RuntimeTaskSessionSummary } from "../../../src/core";
import { deriveTaskIndicatorState, MAX_RUNTIME_TASK_SUBAGENT_INTERACTIONS } from "../../../src/core";
import type { SessionTransitionEvent } from "../../../src/terminal/session-state-machine";
import { InMemorySessionSummaryStore } from "../../../src/terminal/session-summary-store";
import { resolveInteractionResponseTarget } from "../../../src/terminal/subagent-interactions";
import {
	createTestProviderHookEvent,
	createTestTaskNativeWorkEvidence,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

const TASK_ID = "task-1";
const LAUNCH = "process-1";

type ProviderHookEvent = Extract<SessionTransitionEvent, { type: "provider.hook" }>;

function createStore(): InMemorySessionSummaryStore {
	const store = new InMemorySessionSummaryStore();
	store.ensureEntry(TASK_ID);
	store.update(
		TASK_ID,
		createTestTaskSessionSummary({
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
		}),
	);
	return store;
}

function agentHook(
	event: RuntimeHookEvent,
	hookEventName: string,
	occurredAt: number,
	metadata: Omit<RuntimeHookMetadata, "source" | "hookEventName"> = {},
	options: { correlatedToolUseId?: string | null; subagentToolUseCandidates?: string[] } = {},
): ProviderHookEvent {
	return {
		...createTestProviderHookEvent(event, {
			source: "claude",
			hookEventName,
			occurredAt,
			metadata: {
				sessionInstanceId: LAUNCH,
				sessionId: "session-1",
				promptId: "prompt-1",
				providerAgentId: "agent-a",
				...metadata,
			},
			correlatedToolUseId: options.correlatedToolUseId ?? null,
		}),
		subagentToolUseCandidates: options.subagentToolUseCandidates ?? null,
	};
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

describe("queued subagent interactions", () => {
	it("keeps an uncorrelated wait open when a parallel sibling that needed no approval completes", () => {
		const store = createStore();
		// WebFetch and Bash ran in parallel; only Bash asked. Name filtering left two Bash candidates.
		apply(store, agentHook("to_in_progress", "PreToolUse", 100, { toolUseId: "fetch-1", toolName: "WebFetch" }));
		apply(
			store,
			agentHook(
				"to_review",
				"PermissionRequest",
				110,
				{ toolName: "Bash" },
				{ subagentToolUseCandidates: ["bash-1", "bash-2"] },
			),
		);

		apply(store, agentHook("to_in_progress", "PostToolUse", 120, { toolUseId: "fetch-1", toolName: "WebFetch" }));
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");

		apply(store, agentHook("to_in_progress", "PostToolUse", 130, { toolUseId: "bash-2", toolName: "Bash" }));
		expect(summaryOf(store).subagentInteractions?.[0]).toMatchObject({ status: "waiting", toolUseId: "bash-1" });

		apply(store, agentHook("to_in_progress", "PostToolUse", 140, { toolUseId: "bash-1", toolName: "Bash" }));
		expect(summaryOf(store).subagentInteractions).toEqual([]);
	});

	it("keeps an identity-free wait open on a later completion of a different tool", () => {
		const store = createStore();
		apply(store, agentHook("to_review", "PermissionRequest", 110, { toolName: "Bash" }));

		apply(store, agentHook("to_in_progress", "PostToolUse", 120, { toolUseId: "fetch-1", toolName: "WebFetch" }));

		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");
	});

	it("tracks two queued prompts from one subagent separately", () => {
		const store = createStore();
		const candidates = { subagentToolUseCandidates: ["bash-1", "bash-2"] };
		apply(store, agentHook("to_review", "PermissionRequest", 110, { toolName: "Bash" }, candidates));
		apply(store, agentHook("to_review", "PermissionRequest", 111, { toolName: "Bash" }, candidates));
		expect(summaryOf(store).subagentInteractions).toHaveLength(2);

		apply(store, { type: "interaction.response_submitted", responseKind: "submit", occurredAt: 120 });
		expect(summaryOf(store).subagentInteractions?.map((wait) => wait.status)).toEqual([
			"response_submitted",
			"waiting",
		]);
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");

		// One approved tool completes; the answered prompt is the one that resolved.
		apply(store, agentHook("to_in_progress", "PostToolUse", 130, { toolUseId: "bash-1", toolName: "Bash" }));
		expect(summaryOf(store).subagentInteractions).toEqual([
			expect.objectContaining({ status: "waiting", toolUseId: "bash-2", openedAt: 111 }),
		]);
		expect(deriveTaskIndicatorState(summaryOf(store)).kind).toBe("approval_required");
	});

	it("routes an answer to the foreground dialog when the subagent prompt is a different kind", () => {
		const store = createStore();
		apply(store, agentHook("to_review", "Elicitation", 100, { elicitationId: "elicitation-1" }));
		apply(
			store,
			agentHook(
				"to_review",
				"PermissionRequest",
				110,
				{ providerAgentId: null, toolName: "Bash" },
				{ correlatedToolUseId: "main-1" },
			),
		);
		const summary = summaryOf(store);
		expect(resolveInteractionResponseTarget(summary, summary.outstandingInteraction)?.providerAgentId).toBeNull();

		apply(store, { type: "interaction.response_submitted", responseKind: "submit", occurredAt: 120 });

		expect(summaryOf(store).outstandingInteraction?.status).toBe("response_submitted");
		expect(summaryOf(store).subagentInteractions?.[0]?.status).toBe("waiting");
	});

	it("evicts answered waits before waiting ones at the cap", () => {
		const store = createStore();
		apply(
			store,
			agentHook("to_review", "PermissionRequest", 1, { providerAgentId: "agent-0" }, { correlatedToolUseId: "t-0" }),
		);
		apply(store, { type: "interaction.response_submitted", responseKind: "submit", occurredAt: 2 });
		apply(
			store,
			agentHook("to_review", "PermissionRequest", 3, { providerAgentId: "agent-1" }, { correlatedToolUseId: "t-1" }),
		);
		for (let index = 2; index <= MAX_RUNTIME_TASK_SUBAGENT_INTERACTIONS; index += 1) {
			apply(
				store,
				agentHook(
					"to_review",
					"PermissionRequest",
					10 + index,
					{ providerAgentId: `agent-${index}` },
					{
						correlatedToolUseId: `t-${index}`,
					},
				),
			);
		}

		const waits = summaryOf(store).subagentInteractions ?? [];
		expect(waits).toHaveLength(MAX_RUNTIME_TASK_SUBAGENT_INTERACTIONS);
		expect(waits.every((wait) => wait.status === "waiting")).toBe(true);
		expect(waits[0]?.providerAgentId).toBe("agent-1");
	});
});
