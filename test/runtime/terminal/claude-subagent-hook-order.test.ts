import { describe, expect, it } from "vitest";

import type { RuntimeHookEvent, RuntimeHookIngestRequest } from "../../../src/core";
import {
	commitHookEventOrder,
	correlateClaudePermissionToolUseId,
	createHookEventOrderState,
	createProviderHookOrderObservation,
	evaluateHookEventOrder,
	type HookEventOrderState,
	recordHookUserSubmission,
} from "../../../src/terminal/hook-event-order";
import { createTestTaskOutstandingInteraction } from "../../utilities/task-session-factory";

const LAUNCH = "process-1";
let deliveryIndex = 0;

function claudeHook(
	event: RuntimeHookEvent,
	hookEventName: string,
	occurredAt: number,
	metadata: { providerAgentId?: string; toolUseId?: string; toolName?: string; promptId?: string } = {},
): RuntimeHookIngestRequest {
	deliveryIndex += 1;
	return {
		taskId: "task-1",
		projectId: "project-1",
		event,
		metadata: {
			source: "claude",
			hookEventName,
			sessionInstanceId: LAUNCH,
			sessionId: "session-1",
			promptId: metadata.promptId ?? "prompt-1",
			toolUseId: metadata.toolUseId,
			toolName: metadata.toolName,
			providerAgentId: metadata.providerAgentId,
		},
		delivery: { id: `00000000-0000-4000-8000-${String(deliveryIndex).padStart(12, "0")}`, occurredAt },
	};
}

function acceptAndCommit(state: HookEventOrderState, input: RuntimeHookIngestRequest): void {
	expect(evaluateHookEventOrder(state, input)).toEqual({ accepted: true });
	commitHookEventOrder(state, input, { advanceTurn: true });
}

function promptState(): HookEventOrderState {
	const state = createHookEventOrderState(LAUNCH);
	acceptAndCommit(state, claudeHook("to_in_progress", "UserPromptSubmit", 10));
	return state;
}

describe("Claude subagent hook ordering", () => {
	it("correlates permission requests only within the requesting subagent", () => {
		const state = promptState();
		acceptAndCommit(state, claudeHook("to_in_progress", "PreToolUse", 20, { toolUseId: "main-1", toolName: "Bash" }));
		acceptAndCommit(
			state,
			claudeHook("to_in_progress", "PreToolUse", 21, {
				providerAgentId: "agent-a",
				toolUseId: "a-1",
				toolName: "Bash",
			}),
		);
		acceptAndCommit(
			state,
			claudeHook("to_in_progress", "PreToolUse", 22, {
				providerAgentId: "agent-b",
				toolUseId: "b-1",
				toolName: "Bash",
			}),
		);

		expect(
			correlateClaudePermissionToolUseId(
				state,
				claudeHook("to_review", "PermissionRequest", 30, { providerAgentId: "agent-a", toolName: "Bash" }),
			),
		).toBe("a-1");
		expect(
			correlateClaudePermissionToolUseId(
				state,
				claudeHook("to_review", "PermissionRequest", 30, { toolName: "Bash" }),
			),
		).toBe("main-1");
		expect([...state.claudePendingToolUses.keys()]).toEqual(["main-1"]);
	});

	it("keeps subagent hooks out of foreground prompt ordering and durable receipts", () => {
		const state = promptState();
		const subagentHook = claudeHook("to_in_progress", "PreToolUse", 50, {
			providerAgentId: "agent-a",
			toolUseId: "a-1",
		});
		acceptAndCommit(state, subagentHook);

		expect(createProviderHookOrderObservation(subagentHook)).toBeNull();
		expect(state.activeClaudePromptLatestOccurredAt).toBe(10);
		// A foreground Stop without a prompt id is not stale merely because a subagent hook was later.
		const stop = claudeHook("to_review", "Stop", 40);
		stop.metadata = { ...stop.metadata, promptId: null };
		expect(evaluateHookEventOrder(state, stop)).toEqual({ accepted: true });
	});

	it("fences delayed requests only for the subagent whose prompt the user answered", () => {
		const state = promptState();
		recordHookUserSubmission(
			state,
			200,
			createTestTaskOutstandingInteraction({ kind: "permission", providerAgentId: "agent-a", toolUseId: "a-1" }),
		);

		expect(
			evaluateHookEventOrder(
				state,
				claudeHook("to_review", "PermissionRequest", 150, { providerAgentId: "agent-a" }),
			),
		).toEqual({ accepted: false, reason: "resolved_by_user_input" });
		expect(
			evaluateHookEventOrder(
				state,
				claudeHook("to_review", "PermissionRequest", 150, { providerAgentId: "agent-b" }),
			),
		).toEqual({ accepted: true });
		expect(evaluateHookEventOrder(state, claudeHook("to_review", "PermissionRequest", 150))).toEqual({
			accepted: true,
		});

		recordHookUserSubmission(state, 300, createTestTaskOutstandingInteraction({ kind: "permission" }));
		expect(evaluateHookEventOrder(state, claudeHook("to_review", "PermissionRequest", 250))).toEqual({
			accepted: false,
			reason: "resolved_by_user_input",
		});
		expect(
			evaluateHookEventOrder(
				state,
				claudeHook("to_review", "PermissionRequest", 250, { providerAgentId: "agent-b" }),
			),
		).toEqual({ accepted: true });
	});

	it("rejects delayed requests from a subagent that already completed the tool or stopped", () => {
		const state = promptState();
		acceptAndCommit(
			state,
			claudeHook("to_in_progress", "PreToolUse", 100, {
				providerAgentId: "agent-a",
				toolUseId: "a-1",
				toolName: "Bash",
			}),
		);
		acceptAndCommit(
			state,
			claudeHook("to_in_progress", "PostToolUse", 200, {
				providerAgentId: "agent-a",
				toolUseId: "a-1",
				toolName: "Bash",
			}),
		);
		expect(
			evaluateHookEventOrder(
				state,
				claudeHook("to_review", "PermissionRequest", 150, { providerAgentId: "agent-a", toolName: "Bash" }),
			),
		).toEqual({ accepted: false, reason: "completed_tool" });
		expect(
			evaluateHookEventOrder(
				state,
				claudeHook("to_review", "PermissionRequest", 150, { providerAgentId: "agent-b", toolName: "Bash" }),
			),
		).toEqual({ accepted: true });
		// Subagent tool completions do not reject a foreground request either.
		expect(
			evaluateHookEventOrder(state, claudeHook("to_review", "PermissionRequest", 150, { toolName: "Bash" })),
		).toEqual({ accepted: true });

		acceptAndCommit(state, claudeHook("activity", "SubagentStop", 300, { providerAgentId: "agent-a" }));
		expect(
			evaluateHookEventOrder(
				state,
				claudeHook("to_review", "PermissionRequest", 250, { providerAgentId: "agent-a" }),
			),
		).toEqual({ accepted: false, reason: "stale_observation" });
	});

	it("applies only the root-completion fence to subagent hooks", () => {
		const state = promptState();
		acceptAndCommit(state, claudeHook("to_review", "Stop", 400));

		expect(
			evaluateHookEventOrder(
				state,
				claudeHook("to_review", "PermissionRequest", 350, { providerAgentId: "agent-a" }),
			),
		).toEqual({ accepted: false, reason: "stale_observation" });
		// The prompt that launched the subagent is retired, but the reducer, not
		// prompt retirement, decides whether a subagent wait may open.
		expect(
			evaluateHookEventOrder(
				state,
				claudeHook("to_review", "PermissionRequest", 450, { providerAgentId: "agent-a" }),
			),
		).toEqual({ accepted: true });
	});

	it("admits a retained subagent wait's resolution after a new foreground prompt", () => {
		const state = promptState();
		acceptAndCommit(
			state,
			claudeHook("to_in_progress", "PreToolUse", 310, { providerAgentId: "agent-a", toolUseId: "a-1" }),
		);
		acceptAndCommit(state, claudeHook("to_review", "PermissionRequest", 320, { providerAgentId: "agent-a" }));
		acceptAndCommit(state, claudeHook("to_in_progress", "UserPromptSubmit", 330, { promptId: "prompt-2" }));

		acceptAndCommit(
			state,
			claudeHook("to_in_progress", "PostToolUse", 340, { providerAgentId: "agent-a", toolUseId: "a-1" }),
		);
		acceptAndCommit(state, claudeHook("to_review", "PermissionRequest", 350, { providerAgentId: "agent-a" }));
		// Foreground hooks of the retired prompt stay fenced.
		expect(evaluateHookEventOrder(state, claudeHook("to_review", "PermissionRequest", 360))).toEqual({
			accepted: false,
			reason: "completed_prompt",
		});
	});
});
