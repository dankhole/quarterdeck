import { describe, expect, it } from "vitest";

import type { RuntimeHookEvent, RuntimeHookIngestRequest } from "../../../src/core";
import {
	commitHookEventOrder,
	correlateClaudePermissionToolUseId,
	correlateCodexPermissionToolUseId,
	createHookEventOrderState,
	createProviderHookOrderObservation,
	evaluateHookEventOrder,
	recordHookUserSubmission,
	restoreHookEventOrderState,
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
	promptId?: string;
	notificationType?: string;
	elicitationId?: string;
	providerAgentId?: string;
	source?: "codex" | "claude" | "pi";
	deliveryIndex?: number;
	occurredAt?: number;
	sessionInstanceId?: string;
}): RuntimeHookIngestRequest {
	return {
		taskId: "task-1",
		projectId: "project-1",
		event: input.event,
		metadata: {
			source: input.source ?? "codex",
			hookEventName: input.hookEventName,
			sessionInstanceId: input.sessionInstanceId ?? SESSION_INSTANCE_ID,
			turnId: input.turnId,
			toolName: input.toolName,
			toolUseId: input.toolUseId,
			promptId: input.promptId,
			notificationType: input.notificationType,
			elicitationId: input.elicitationId,
			providerAgentId: input.providerAgentId,
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
	it("correlates one open PreToolUse to Codex PermissionRequest and fences a parallel completion", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "activity",
				hookEventName: "PreToolUse",
				turnId: "turn-1",
				toolName: "Bash",
				toolUseId: "tool-approval",
				deliveryIndex: 1,
				occurredAt: 100,
			}),
		);
		const permission = hook({
			event: "to_review",
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
			deliveryIndex: 2,
			occurredAt: 110,
		});

		expect(correlateCodexPermissionToolUseId(state, permission)).toBe("tool-approval");
		acceptAndCommit(state, permission);
		expect(state.pendingPermission?.toolUseId).toBe("tool-approval");
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "to_in_progress",
					hookEventName: "PostToolUse",
					turnId: "turn-1",
					toolName: "Bash",
					toolUseId: "tool-parallel",
					deliveryIndex: 3,
					occurredAt: 120,
				}),
			),
		).toEqual({ accepted: false, reason: "unrelated_tool_completion" });
	});

	it("leaves parallel same-name Codex tools uncorrelated", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		for (const [index, toolUseId] of ["tool-1", "tool-2"].entries()) {
			acceptAndCommit(
				state,
				hook({
					event: "activity",
					hookEventName: "PreToolUse",
					turnId: "turn-1",
					toolName: "Bash",
					toolUseId,
					deliveryIndex: index + 1,
					occurredAt: 100 + index,
				}),
			);
		}

		expect(
			correlateCodexPermissionToolUseId(
				state,
				hook({
					event: "to_review",
					hookEventName: "PermissionRequest",
					turnId: "turn-1",
					toolName: "Bash",
					deliveryIndex: 3,
					occurredAt: 110,
				}),
			),
		).toBeNull();
	});

	it("retires an answered Codex tool before correlating the next same-turn permission", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "activity",
				hookEventName: "PreToolUse",
				turnId: "turn-1",
				toolName: "Bash",
				toolUseId: "tool-1",
				deliveryIndex: 1,
				occurredAt: 100,
			}),
		);
		const firstPermission = hook({
			event: "to_review",
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
			deliveryIndex: 2,
			occurredAt: 110,
		});
		acceptAndCommit(state, firstPermission);
		recordHookUserSubmission(state, 120, {
			provider: "codex",
			kind: "permission",
			status: "waiting",
			requestEventName: "PermissionRequest",
			openedAt: 110,
			updatedAt: 110,
			responseSubmittedAt: null,
			responseKind: null,
			sessionInstanceId: SESSION_INSTANCE_ID,
			providerSessionId: "session-1",
			turnId: "turn-1",
			promptId: null,
			toolUseId: "tool-1",
			elicitationId: null,
			providerAgentId: null,
			toolName: "Bash",
		});
		acceptAndCommit(
			state,
			hook({
				event: "activity",
				hookEventName: "PreToolUse",
				turnId: "turn-1",
				toolName: "Bash",
				toolUseId: "tool-2",
				deliveryIndex: 3,
				occurredAt: 130,
			}),
		);

		expect(
			correlateCodexPermissionToolUseId(
				state,
				hook({
					event: "to_review",
					hookEventName: "PermissionRequest",
					turnId: "turn-1",
					toolName: "Bash",
					deliveryIndex: 4,
					occurredAt: 140,
				}),
			),
		).toBe("tool-2");
	});

	it("rebuilds Codex permission correlation from durable hook observations", () => {
		const preToolUse = hook({
			event: "activity",
			hookEventName: "PreToolUse",
			turnId: "turn-1",
			toolName: "Bash",
			toolUseId: "tool-1",
			deliveryIndex: 1,
			occurredAt: 100,
		});
		const permission = hook({
			event: "to_review",
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
			deliveryIndex: 2,
			occurredAt: 110,
		});
		const observations = [preToolUse, permission]
			.map(createProviderHookOrderObservation)
			.filter((observation) => observation !== null);

		const restored = restoreHookEventOrderState({
			sessionInstanceId: SESSION_INSTANCE_ID,
			observations,
			recentDeliveryIds: observations.map((observation) => observation.deliveryId),
			outstandingInteraction: null,
		});

		expect(restored.pendingPermission?.toolUseId).toBe("tool-1");
		expect(
			evaluateHookEventOrder(
				restored,
				hook({
					event: "to_in_progress",
					hookEventName: "PostToolUse",
					turnId: "turn-1",
					toolName: "Bash",
					toolUseId: "tool-1",
					deliveryIndex: 3,
					occurredAt: 120,
				}),
			),
		).toEqual({ accepted: true });
	});

	it("rebuilds intentionally retained parallel completions from durable hook observations", () => {
		const permission = hook({
			event: "to_review",
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
			deliveryIndex: 1,
			occurredAt: 100,
		});
		const parallelCompletion = hook({
			event: "to_in_progress",
			hookEventName: "PostToolUse",
			turnId: "turn-1",
			toolName: "apply_patch",
			toolUseId: "parallel-tool",
			deliveryIndex: 2,
			occurredAt: 120,
		});
		const observations = [permission, parallelCompletion]
			.map(createProviderHookOrderObservation)
			.filter((observation) => observation !== null);

		const restored = restoreHookEventOrderState({
			sessionInstanceId: SESSION_INSTANCE_ID,
			observations,
			recentDeliveryIds: observations.map((observation) => observation.deliveryId),
			outstandingInteraction: null,
		});

		expect(restored.pendingPermission?.toolName).toBe("bash");
		expect(
			evaluateHookEventOrder(
				restored,
				hook({
					event: "to_review",
					hookEventName: "PermissionRequest",
					turnId: "turn-1",
					toolName: "apply_patch",
					deliveryIndex: 3,
					occurredAt: 110,
				}),
			),
		).toEqual({ accepted: false, reason: "completed_tool" });
	});

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

	it("accepts later tool work after local input retires only the permission ordering guard", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "to_review",
				hookEventName: "PermissionRequest",
				turnId: "turn-1",
				toolName: "Bash",
				deliveryIndex: 1,
				occurredAt: 100,
			}),
		);

		recordHookUserSubmission(state, 200);
		expect(state.pendingPermission).toBeNull();
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "to_in_progress",
					hookEventName: "PostToolUse",
					turnId: "turn-1",
					toolName: "Read",
					toolUseId: "tool-2",
					deliveryIndex: 2,
					occurredAt: 250,
				}),
			),
		).toEqual({ accepted: true });
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

	it("uses an identity-poor root Stop as a durable active-turn completion barrier", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		const firstTool = hook({
			event: "activity",
			hookEventName: "PreToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			deliveryIndex: 10,
			occurredAt: 100,
		});
		const rootStop = hook({ event: "to_review", hookEventName: "Stop", deliveryIndex: 11, occurredAt: 200 });
		acceptAndCommit(state, firstTool);
		acceptAndCommit(state, rootStop);

		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "activity",
					hookEventName: "PreToolUse",
					turnId: "turn-1",
					toolUseId: "delayed-tool",
					deliveryIndex: 12,
					occurredAt: 150,
				}),
			),
		).toEqual({ accepted: false, reason: "stale_observation" });
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					event: "activity",
					hookEventName: "PreToolUse",
					turnId: "turn-2",
					toolUseId: "new-tool",
					deliveryIndex: 13,
					occurredAt: 300,
				}),
			),
		).toEqual({ accepted: true });

		const observations = [firstTool, rootStop]
			.map(createProviderHookOrderObservation)
			.filter((observation) => observation !== null);
		const restored = restoreHookEventOrderState({
			sessionInstanceId: SESSION_INSTANCE_ID,
			observations,
			recentDeliveryIds: observations.map((observation) => observation.deliveryId),
			outstandingInteraction: null,
		});
		expect(
			evaluateHookEventOrder(
				restored,
				hook({
					event: "activity",
					hookEventName: "PreToolUse",
					turnId: "turn-1",
					toolUseId: "restored-delayed-tool",
					deliveryIndex: 14,
					occurredAt: 150,
				}),
			),
		).toEqual({ accepted: false, reason: "stale_observation" });
	});

	it("rejects an identity-poor Stop that does not follow the active turn", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				event: "activity",
				hookEventName: "PreToolUse",
				turnId: "turn-1",
				deliveryIndex: 20,
				occurredAt: 200,
			}),
		);

		expect(
			evaluateHookEventOrder(
				state,
				hook({ event: "to_review", hookEventName: "Stop", deliveryIndex: 21, occurredAt: 200 }),
			),
		).toEqual({ accepted: false, reason: "stale_observation" });
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

describe("Pi hook event ordering", () => {
	it("uses agent_settled as the run completion boundary", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				source: "pi",
				event: "to_in_progress",
				hookEventName: "AgentStart",
				turnId: "run-1",
				deliveryIndex: 100,
				occurredAt: 100,
			}),
		);
		acceptAndCommit(
			state,
			hook({
				source: "pi",
				event: "activity",
				hookEventName: "AgentEnd",
				turnId: "run-1",
				deliveryIndex: 101,
				occurredAt: 200,
			}),
		);
		expect(state.activePiRunCompleted).toBe(false);

		acceptAndCommit(
			state,
			hook({
				source: "pi",
				event: "to_review",
				hookEventName: "AgentSettled",
				turnId: "run-1",
				deliveryIndex: 102,
				occurredAt: 300,
			}),
		);
		expect(state.activePiRunCompleted).toBe(true);
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "pi",
					event: "activity",
					hookEventName: "ToolExecutionEnd",
					turnId: "run-1",
					toolUseId: "tool-1",
					deliveryIndex: 103,
					occurredAt: 250,
				}),
			),
		).toEqual({ accepted: false, reason: "completed_turn" });
	});

	it("rejects stale Pi tool and run identities", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				source: "pi",
				event: "to_in_progress",
				hookEventName: "PermissionResolved",
				turnId: "run-1",
				toolUseId: "tool-1",
				deliveryIndex: 110,
				occurredAt: 200,
			}),
		);
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "pi",
					event: "to_review",
					hookEventName: "PermissionRequest",
					turnId: "run-1",
					toolUseId: "tool-1",
					deliveryIndex: 111,
					occurredAt: 100,
				}),
			),
		).toEqual({ accepted: false, reason: "completed_tool" });

		acceptAndCommit(
			state,
			hook({
				source: "pi",
				event: "to_in_progress",
				hookEventName: "AgentStart",
				turnId: "run-2",
				deliveryIndex: 112,
				occurredAt: 300,
			}),
		);
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "pi",
					event: "to_review",
					hookEventName: "AgentSettled",
					turnId: "run-1",
					deliveryIndex: 113,
					occurredAt: 250,
				}),
			),
		).toEqual({ accepted: false, reason: "stale_turn" });
	});
});

describe("Claude hook event ordering", () => {
	it("retires an answered permission identity and rejects older delayed requests", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				source: "claude",
				event: "activity",
				hookEventName: "PreToolUse",
				promptId: "prompt-1",
				toolUseId: "tool-1",
				toolName: "Bash",
				deliveryIndex: 1,
				occurredAt: 100,
			}),
		);
		recordHookUserSubmission(state, 200, {
			provider: "claude",
			kind: "permission",
			status: "waiting",
			requestEventName: "PermissionRequest",
			openedAt: 110,
			updatedAt: 110,
			responseSubmittedAt: null,
			responseKind: null,
			sessionInstanceId: SESSION_INSTANCE_ID,
			providerSessionId: "session-1",
			turnId: null,
			promptId: "prompt-1",
			toolUseId: "tool-1",
			elicitationId: null,
			providerAgentId: null,
			toolName: "Bash",
		});

		expect(
			correlateClaudePermissionToolUseId(
				state,
				hook({
					source: "claude",
					event: "to_review",
					hookEventName: "PermissionRequest",
					promptId: "prompt-1",
					toolName: "Bash",
					deliveryIndex: 2,
					occurredAt: 210,
				}),
			),
		).toBeNull();
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "claude",
					event: "to_review",
					hookEventName: "PermissionRequest",
					promptId: "prompt-1",
					toolName: "Bash",
					deliveryIndex: 3,
					occurredAt: 150,
				}),
			),
		).toEqual({ accepted: false, reason: "resolved_by_user_input" });
	});
	it("correlates PermissionRequest with exactly one preceding PreToolUse", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				source: "claude",
				event: "activity",
				hookEventName: "PreToolUse",
				promptId: "prompt-1",
				toolName: "Bash",
				toolUseId: "tool-1",
				deliveryIndex: 1,
				occurredAt: 100,
			}),
		);
		const permission = hook({
			source: "claude",
			event: "to_review",
			hookEventName: "PermissionRequest",
			promptId: "prompt-1",
			toolName: "Bash",
			deliveryIndex: 2,
			occurredAt: 110,
		});

		expect(correlateClaudePermissionToolUseId(state, permission)).toBe("tool-1");
	});

	it("fails closed when parallel matching tool uses make permission correlation ambiguous", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		for (const [index, toolUseId] of ["tool-1", "tool-2"].entries()) {
			acceptAndCommit(
				state,
				hook({
					source: "claude",
					event: "activity",
					hookEventName: "PreToolUse",
					promptId: "prompt-1",
					toolName: "Bash",
					toolUseId,
					deliveryIndex: 10 + index,
					occurredAt: 100 + index,
				}),
			);
		}
		const permission = hook({
			source: "claude",
			event: "to_review",
			hookEventName: "PermissionRequest",
			promptId: "prompt-1",
			toolName: "Bash",
			deliveryIndex: 12,
			occurredAt: 110,
		});

		expect(correlateClaudePermissionToolUseId(state, permission)).toBeNull();
	});

	it("rejects a delayed permission after the matching Claude tool completed", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				source: "claude",
				event: "activity",
				hookEventName: "PreToolUse",
				promptId: "prompt-1",
				toolName: "Bash",
				toolUseId: "tool-1",
				deliveryIndex: 20,
				occurredAt: 100,
			}),
		);
		acceptAndCommit(
			state,
			hook({
				source: "claude",
				event: "to_in_progress",
				hookEventName: "PostToolUse",
				promptId: "prompt-1",
				toolName: "Bash",
				toolUseId: "tool-1",
				deliveryIndex: 21,
				occurredAt: 200,
			}),
		);

		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "claude",
					event: "to_review",
					hookEventName: "PermissionRequest",
					promptId: "prompt-1",
					toolName: "Bash",
					deliveryIndex: 22,
					occurredAt: 150,
				}),
			),
		).toEqual({ accepted: false, reason: "completed_tool" });
	});

	it("rejects hooks from a prior Claude prompt after a newer prompt begins", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				source: "claude",
				event: "to_in_progress",
				hookEventName: "UserPromptSubmit",
				promptId: "prompt-2",
				deliveryIndex: 30,
				occurredAt: 300,
			}),
		);

		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "claude",
					event: "to_review",
					hookEventName: "Stop",
					promptId: "prompt-1",
					deliveryIndex: 31,
					occurredAt: 200,
				}),
			),
		).toEqual({ accepted: false, reason: "stale_prompt" });
	});

	it("uses an identity-poor root Stop as a durable active-prompt completion barrier", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		const firstTool = hook({
			source: "claude",
			event: "activity",
			hookEventName: "PreToolUse",
			promptId: "prompt-1",
			toolUseId: "tool-1",
			deliveryIndex: 35,
			occurredAt: 100,
		});
		const rootStop = hook({
			source: "claude",
			event: "to_review",
			hookEventName: "Stop",
			deliveryIndex: 36,
			occurredAt: 200,
		});
		acceptAndCommit(state, firstTool);
		acceptAndCommit(state, rootStop);

		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "claude",
					event: "activity",
					hookEventName: "PreToolUse",
					promptId: "prompt-1",
					toolUseId: "delayed-tool",
					deliveryIndex: 37,
					occurredAt: 150,
				}),
			),
		).toEqual({ accepted: false, reason: "stale_observation" });
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "claude",
					event: "activity",
					hookEventName: "PreToolUse",
					promptId: "prompt-2",
					toolUseId: "new-tool",
					deliveryIndex: 38,
					occurredAt: 300,
				}),
			),
		).toEqual({ accepted: true });

		const observations = [firstTool, rootStop]
			.map(createProviderHookOrderObservation)
			.filter((observation) => observation !== null);
		const restored = restoreHookEventOrderState({
			sessionInstanceId: SESSION_INSTANCE_ID,
			observations,
			recentDeliveryIds: observations.map((observation) => observation.deliveryId),
			outstandingInteraction: null,
		});
		expect(
			evaluateHookEventOrder(
				restored,
				hook({
					source: "claude",
					event: "activity",
					hookEventName: "PreToolUse",
					promptId: "prompt-1",
					toolUseId: "restored-delayed-tool",
					deliveryIndex: 39,
					occurredAt: 150,
				}),
			),
		).toEqual({ accepted: false, reason: "stale_observation" });
	});

	it("does not retire a Claude prompt for a root Stop still waiting on background work", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		const promptStart = hook({
			source: "claude",
			event: "to_in_progress",
			hookEventName: "UserPromptSubmit",
			promptId: "prompt-1",
			deliveryIndex: 60,
			occurredAt: 100,
		});
		const pendingBackgroundStop = hook({
			source: "claude",
			event: "activity",
			hookEventName: "Stop",
			promptId: "prompt-1",
			deliveryIndex: 61,
			occurredAt: 200,
		});
		const subagentStop = hook({
			source: "claude",
			event: "activity",
			hookEventName: "SubagentStop",
			promptId: "prompt-1",
			providerAgentId: "background-1",
			deliveryIndex: 62,
			occurredAt: 300,
		});
		const completedStop = hook({
			source: "claude",
			event: "to_review",
			hookEventName: "Stop",
			promptId: "prompt-1",
			deliveryIndex: 63,
			occurredAt: 400,
		});

		for (const input of [promptStart, pendingBackgroundStop, subagentStop, completedStop]) {
			acceptAndCommit(state, input);
		}
		expect(state.retiredClaudePromptIds.has("prompt-1")).toBe(true);
		expect(state.latestClaudeRootCompletionOccurredAt).toBe(400);
	});

	it("rejects delayed elicitation requests after their native result", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				source: "claude",
				event: "to_in_progress",
				hookEventName: "ElicitationResult",
				promptId: "prompt-1",
				elicitationId: "elicitation-1",
				deliveryIndex: 40,
				occurredAt: 200,
			}),
		);

		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "claude",
					event: "to_review",
					hookEventName: "Elicitation",
					promptId: "prompt-1",
					elicitationId: "elicitation-1",
					deliveryIndex: 41,
					occurredAt: 100,
				}),
			),
		).toEqual({ accepted: false, reason: "completed_interaction" });
		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "claude",
					event: "to_review",
					hookEventName: "Notification",
					notificationType: "elicitation_dialog",
					promptId: "prompt-1",
					deliveryIndex: 42,
					occurredAt: 150,
				}),
			),
		).toEqual({ accepted: false, reason: "completed_interaction" });
	});

	it("rejects a delayed unscoped elicitation after its native result", () => {
		const state = createHookEventOrderState(SESSION_INSTANCE_ID);
		acceptAndCommit(
			state,
			hook({
				source: "claude",
				event: "to_in_progress",
				hookEventName: "ElicitationResult",
				deliveryIndex: 50,
				occurredAt: 200,
			}),
		);

		expect(
			evaluateHookEventOrder(
				state,
				hook({
					source: "claude",
					event: "to_review",
					hookEventName: "Elicitation",
					deliveryIndex: 51,
					occurredAt: 100,
				}),
			),
		).toEqual({ accepted: false, reason: "completed_interaction" });
	});
});
