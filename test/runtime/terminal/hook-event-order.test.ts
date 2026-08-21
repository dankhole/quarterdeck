import { describe, expect, it } from "vitest";

import type { RuntimeHookEvent, RuntimeHookIngestRequest } from "../../../src/core";
import {
	commitHookEventOrder,
	createHookEventOrderState,
	evaluateHookEventOrder,
} from "../../../src/terminal/hook-event-order";

const SESSION_INSTANCE_ID = "process-1";

function delivery(index: number, occurredAt: number): NonNullable<RuntimeHookIngestRequest["delivery"]> {
	return {
		id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		occurredAt,
	};
}

function hook(input: {
	event: RuntimeHookEvent;
	hookEventName: string;
	turnId?: string;
	toolName?: string;
	toolUseId?: string;
	deliveryIndex?: number;
	occurredAt?: number;
	sessionInstanceId?: string;
}): RuntimeHookIngestRequest {
	return {
		taskId: "task-1",
		projectId: "project-1",
		event: input.event,
		metadata: {
			source: "codex",
			hookEventName: input.hookEventName,
			sessionInstanceId: input.sessionInstanceId ?? SESSION_INSTANCE_ID,
			turnId: input.turnId,
			toolName: input.toolName,
			toolUseId: input.toolUseId,
		},
		delivery:
			input.deliveryIndex === undefined
				? undefined
				: delivery(input.deliveryIndex, input.occurredAt ?? input.deliveryIndex * 100),
	};
}

function acceptAndCommit(state: ReturnType<typeof createHookEventOrderState>, input: RuntimeHookIngestRequest): void {
	expect(evaluateHookEventOrder(state, input)).toEqual({ accepted: true });
	commitHookEventOrder(state, input, { advanceTurn: true });
}

describe("Codex hook event ordering", () => {
	it("preserves legacy behavior when delivery identity is absent", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		expect(
			evaluateHookEventOrder(state, {
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: { source: "codex", hookEventName: "PermissionRequest" },
			}),
		).toEqual({ accepted: true });
	});

	it("rejects events from a replaced task process", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "to_review",
					hookEventName: "Stop",
					turnId: "turn-1",
					deliveryIndex: 1,
					sessionInstanceId: "old-process",
				}),
			),
		).toEqual({ accepted: false, reason: "stale_session" });
	});

	it("deduplicates a retried delivery", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		const input = hook({
			event: "to_review",
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
			deliveryIndex: 1,
		});
		acceptAndCommit(state, input);

		expect(evaluateHookEventOrder(state, input)).toEqual({ accepted: false, reason: "duplicate_delivery" });
	});

	it("does not let a delayed permission overwrite its later tool completion", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		const permission = hook({
			event: "to_review",
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
			deliveryIndex: 1,
			occurredAt: 100,
		});
		acceptAndCommit(
			state,
			hook({
				event: "to_in_progress",
				hookEventName: "PostToolUse",
				turnId: "turn-1",
				toolName: "Bash",
				toolUseId: "tool-1",
				deliveryIndex: 2,
				occurredAt: 200,
			}),
		);

		expect(evaluateHookEventOrder(state, permission)).toEqual({ accepted: false, reason: "completed_tool" });
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "to_review",
					hookEventName: "PermissionRequest",
					turnId: "turn-1",
					toolName: "Bash",
					deliveryIndex: 3,
					occurredAt: 300,
				}),
			),
		).toEqual({ accepted: true });
	});

	it("still accepts a delayed permission after unrelated later activity in the same turn", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "activity",
				hookEventName: "PreToolUse",
				turnId: "turn-1",
				toolName: "apply_patch",
				deliveryIndex: 2,
				occurredAt: 200,
			}),
		);

		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "to_review",
					hookEventName: "PermissionRequest",
					turnId: "turn-1",
					toolName: "Bash",
					deliveryIndex: 1,
					occurredAt: 100,
				}),
			),
		).toEqual({ accepted: true });
	});

	it("keeps an unrelated tool completion from resolving the active permission", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "to_review",
				hookEventName: "PermissionRequest",
				turnId: "turn-1",
				toolName: "Bash",
				deliveryIndex: 1,
			}),
		);
		const backgroundCompletion = hook({
			event: "to_in_progress",
			hookEventName: "PostToolUse",
			turnId: "turn-1",
			toolName: "apply_patch",
			toolUseId: "tool-background",
			deliveryIndex: 2,
		});

		expect(evaluateHookEventOrder(state, backgroundCompletion)).toEqual({
			accepted: false,
			reason: "unrelated_tool_completion",
		});
		// The UI transition is ignored, but the observation is retained so a
		// delayed permission for the completed tool cannot replace the real wait.
		commitHookEventOrder(state, backgroundCompletion, { advanceTurn: true });
		expect(state.pendingPermission?.toolName).toBe("bash");
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "to_review",
					hookEventName: "PermissionRequest",
					turnId: "turn-1",
					toolName: "apply_patch",
					deliveryIndex: 3,
					occurredAt: 150,
				}),
			),
		).toEqual({ accepted: false, reason: "completed_tool" });
	});

	it("does not let a delayed turn-start hook clear a newer permission wait", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "to_review",
				hookEventName: "PermissionRequest",
				turnId: "turn-1",
				toolName: "Bash",
				deliveryIndex: 2,
				occurredAt: 200,
			}),
		);

		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "to_in_progress",
					hookEventName: "UserPromptSubmit",
					turnId: "turn-1",
					deliveryIndex: 1,
					occurredAt: 100,
				}),
			),
		).toEqual({ accepted: false, reason: "stale_observation" });
	});

	it("ignores a delayed Stop after a newer turn has started", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "activity",
				hookEventName: "PreToolUse",
				turnId: "turn-1",
				deliveryIndex: 1,
				occurredAt: 100,
			}),
		);
		const delayedStop = hook({
			event: "to_review",
			hookEventName: "Stop",
			turnId: "turn-1",
			deliveryIndex: 2,
			occurredAt: 200,
		});
		acceptAndCommit(
			state,
			hook({
				event: "to_in_progress",
				hookEventName: "UserPromptSubmit",
				turnId: "turn-2",
				deliveryIndex: 3,
				occurredAt: 300,
			}),
		);

		expect(evaluateHookEventOrder(state, delayedStop)).toEqual({ accepted: false, reason: "stale_turn" });
	});

	it("does not reopen a completed turn for a late tool event", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(state, hook({ event: "to_review", hookEventName: "Stop", turnId: "turn-1", deliveryIndex: 1 }));

		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "to_in_progress",
					hookEventName: "PostToolUse",
					turnId: "turn-1",
					toolName: "Bash",
					deliveryIndex: 2,
				}),
			),
		).toEqual({ accepted: false, reason: "completed_turn" });
	});

	it("does not let a delayed compact start arrive after compact completion", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "to_review",
				hookEventName: "PostCompact",
				turnId: "turn-1",
				deliveryIndex: 2,
				occurredAt: 200,
			}),
		);

		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "to_in_progress",
					hookEventName: "PreCompact",
					turnId: "turn-1",
					deliveryIndex: 1,
					occurredAt: 100,
				}),
			),
		).toEqual({ accepted: false, reason: "stale_observation" });
	});

	it("accepts the normal manual compact lifecycle", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "to_in_progress",
				hookEventName: "PreCompact",
				turnId: "turn-1",
				deliveryIndex: 1,
				occurredAt: 100,
			}),
		);
		acceptAndCommit(
			state,
			hook({
				event: "to_review",
				hookEventName: "PostCompact",
				turnId: "turn-1",
				deliveryIndex: 2,
				occurredAt: 200,
			}),
		);

		expect(state.activeTurnLatestCompactOccurredAt).toBe(200);
	});

	it("accepts the normal permission, completion, and Stop sequence", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "to_review",
				hookEventName: "PermissionRequest",
				turnId: "turn-1",
				toolName: "Bash",
				deliveryIndex: 1,
			}),
		);
		acceptAndCommit(
			state,
			hook({
				event: "to_in_progress",
				hookEventName: "PostToolUse",
				turnId: "turn-1",
				toolName: "Bash",
				toolUseId: "tool-1",
				deliveryIndex: 2,
			}),
		);
		acceptAndCommit(state, hook({ event: "to_review", hookEventName: "Stop", turnId: "turn-1", deliveryIndex: 3 }));

		expect(state.activeTurnCompleted).toBe(true);
		expect(state.pendingPermission).toBeNull();
	});
});
