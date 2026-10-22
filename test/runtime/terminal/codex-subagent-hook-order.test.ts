import { describe, expect, it } from "vitest";

import type { RuntimeHookEvent, RuntimeHookIngestRequest } from "../../../src/core";
import {
	commitHookEventOrder,
	correlateCodexPermissionToolUseId,
	createHookEventOrderState,
	createProviderHookOrderObservation,
	evaluateHookEventOrder,
	type HookEventOrderState,
	recordHookUserSubmission,
} from "../../../src/terminal/hook-event-order";
import { createTestTaskOutstandingInteraction } from "../../utilities/task-session-factory";

const LAUNCH = "process-1";
let deliveryIndex = 0;

function codexHook(
	event: RuntimeHookEvent,
	hookEventName: string,
	occurredAt: number,
	metadata: {
		providerAgentId?: string;
		sessionId?: string;
		turnId?: string;
		toolUseId?: string;
		toolName?: string;
	} = {},
): RuntimeHookIngestRequest {
	deliveryIndex += 1;
	return {
		taskId: "task-1",
		projectId: "project-1",
		event,
		metadata: {
			source: "codex",
			hookEventName,
			sessionInstanceId: LAUNCH,
			sessionId: "root",
			turnId: "root-turn",
			...metadata,
		},
		delivery: { id: `00000000-0000-4000-8000-${String(deliveryIndex).padStart(12, "0")}`, occurredAt },
	};
}

function child(event: RuntimeHookEvent, hookEventName: string, occurredAt: number, toolUseId?: string) {
	return codexHook(event, hookEventName, occurredAt, {
		providerAgentId: "child-a",
		turnId: "child-turn",
		toolName: "Bash",
		...(toolUseId ? { toolUseId } : {}),
	});
}

function acceptAndCommit(state: HookEventOrderState, input: RuntimeHookIngestRequest): void {
	expect(evaluateHookEventOrder(state, input)).toEqual({ accepted: true });
	commitHookEventOrder(state, input, { advanceTurn: true });
}

function rootState(): HookEventOrderState {
	const state = createHookEventOrderState(LAUNCH);
	acceptAndCommit(state, codexHook("to_in_progress", "UserPromptSubmit", 10));
	acceptAndCommit(state, codexHook("activity", "PreToolUse", 20, { toolUseId: "root-call", toolName: "Bash" }));
	return state;
}

describe("Codex subagent hook ordering", () => {
	it("admits same-session subagent hooks into a per-agent lane without touching the root turn", () => {
		const state = rootState();
		acceptAndCommit(state, child("activity", "PreToolUse", 30, "child-call"));
		const request = child("to_review", "PermissionRequest", 31);

		expect(evaluateHookEventOrder(state, request)).toEqual({ accepted: true });
		expect(correlateCodexPermissionToolUseId(state, request)).toBe("child-call");
		commitHookEventOrder(state, request, { advanceTurn: true });

		expect(state.activeTurnId).toBe("root-turn");
		expect(state.pendingPermission).toBeNull();
		expect([...state.codexPendingToolUses.keys()]).toEqual(["root-call"]);
		// The root request correlates only with the root tool.
		expect(correlateCodexPermissionToolUseId(state, codexHook("to_review", "PermissionRequest", 32))).toBe(
			"root-call",
		);
		expect(createProviderHookOrderObservation(request)).toBeNull();
	});

	it("keeps /btw forks, unverifiable scope, and root-only subagent events non-foreground", () => {
		const unknown = createHookEventOrderState(LAUNCH);
		expect(evaluateHookEventOrder(unknown, child("to_review", "PermissionRequest", 5))).toEqual({
			accepted: false,
			reason: "non_foreground_session",
		});

		const state = rootState();
		expect(
			evaluateHookEventOrder(
				state,
				codexHook("to_review", "PermissionRequest", 40, { providerAgentId: "child-a", sessionId: "side" }),
			),
		).toEqual({ accepted: false, reason: "non_foreground_session" });
		for (const hookEventName of ["Interrupt", "Stop", "SessionStart", "PreCompact"]) {
			expect(evaluateHookEventOrder(state, child("to_review", hookEventName, 41))).toEqual({
				accepted: false,
				reason: "non_foreground_session",
			});
		}
	});

	it("admits subagent hooks after the root turn completed", () => {
		const state = rootState();
		acceptAndCommit(state, codexHook("to_review", "Stop", 50));
		// The child's request occurred before root Stop but arrived later; it is still current.
		acceptAndCommit(state, child("to_review", "PermissionRequest", 45));
		acceptAndCommit(state, child("to_review", "PermissionRequest", 60));
	});

	it("fences delayed requests behind the same subagent's completion or answer only", () => {
		const state = rootState();
		acceptAndCommit(state, child("activity", "PreToolUse", 30, "child-call"));
		acceptAndCommit(state, child("to_in_progress", "PostToolUse", 40, "child-call"));
		expect(evaluateHookEventOrder(state, child("to_review", "PermissionRequest", 35))).toEqual({
			accepted: false,
			reason: "completed_tool",
		});

		recordHookUserSubmission(
			state,
			70,
			createTestTaskOutstandingInteraction({ provider: "codex", providerAgentId: "child-a", toolUseId: null }),
		);
		expect(evaluateHookEventOrder(state, child("to_review", "PermissionRequest", 65))).toEqual({
			accepted: false,
			reason: "resolved_by_user_input",
		});
		// The answer neither fences the root nor other subagents.
		expect(state.latestUserSubmissionAt).toBeNull();
		expect(
			evaluateHookEventOrder(
				state,
				codexHook("to_review", "PermissionRequest", 65, { providerAgentId: "child-b", turnId: "b-turn" }),
			),
		).toEqual({ accepted: true });
	});

	it("drops the lane on foreground navigation", () => {
		const state = rootState();
		acceptAndCommit(state, child("activity", "PreToolUse", 30, "child-call"));
		acceptAndCommit(state, {
			...codexHook("activity", "SessionStart", 40, { sessionId: "new-root" }),
			metadata: {
				source: "codex",
				hookEventName: "SessionStart",
				sessionInstanceId: LAUNCH,
				sessionId: "new-root",
				sessionStartSource: "clear",
			},
		});
		expect(state.subagents.pendingToolUses.size).toBe(0);
		expect(evaluateHookEventOrder(state, child("to_review", "PermissionRequest", 50))).toEqual({
			accepted: false,
			reason: "non_foreground_session",
		});
	});
});
