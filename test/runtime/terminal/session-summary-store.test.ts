import { describe, expect, it } from "vitest";

import { InMemorySessionSummaryStore } from "../../../src/terminal";
import {
	createTestTaskNativeWorkEvidence,
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

describe("InMemorySessionSummaryStore interaction persistence", () => {
	it("normalizes contradictory direct writes instead of exposing false Running", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1" }),
		});

		const unproved = store.update("task-1", {
			state: "running",
			agentId: "codex",
			sessionInstanceId: "process-1",
			pid: 123,
		});
		expect(unproved).toMatchObject({ state: "awaiting_review", reviewReason: "unconfirmed" });

		const contradictory = store.update("task-1", {
			state: "running",
			nativeWorkEvidence: createTestTaskNativeWorkEvidence(),
			outstandingInteraction: createTestTaskOutstandingInteraction({
				provider: "codex",
				kind: "permission",
			}),
		});
		expect(contradictory).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			nativeWorkEvidence: null,
			outstandingInteraction: { status: "waiting" },
		});
	});

	it.each(["codex", "pi"] as const)("invalidates a persisted %s Running lease during cold hydration", (agentId) => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({
				taskId: "task-1",
				state: "running",
				agentId,
				sessionInstanceId: "process-1",
				pid: 123,
				nativeWorkEvidence: createTestTaskNativeWorkEvidence({ provider: agentId }),
			}),
		});

		expect(store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			nativeWorkEvidence: null,
			startupRecoveryRequired: true,
		});
	});

	it("migrates a legacy persisted permission wait into durable interaction state", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({
				taskId: "task-1",
				state: "awaiting_review",
				reviewReason: "hook",
				agentId: "codex",
				sessionInstanceId: "process-1",
				resumeSessionId: "session-1",
				lastHookAt: 100,
				outstandingInteraction: null,
				latestHookActivity: {
					source: "codex",
					hookEventName: "PermissionRequest",
					notificationType: "permission.asked",
					activityText: "Waiting for approval",
				},
			}),
		});

		expect(store.getSummary("task-1")?.outstandingInteraction).toMatchObject({
			provider: "codex",
			kind: "permission",
			status: "waiting",
			openedAt: 100,
			sessionInstanceId: "process-1",
			providerSessionId: "session-1",
		});
	});

	it("does not migrate a global Claude notification into task interaction authority", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({
				taskId: "task-1",
				state: "awaiting_review",
				reviewReason: "hook",
				agentId: "claude",
				outstandingInteraction: null,
				latestHookActivity: {
					source: "claude",
					hookEventName: "Notification",
					notificationType: "permission_prompt",
					activityText: "Waiting for approval",
				},
			}),
		});

		expect(store.getSummary("task-1")?.outstandingInteraction).toBeNull();
	});

	it("applies provider semantics and matching activity atomically while preserving an active wait from unrelated hooks", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({
				taskId: "task-1",
				state: "running",
				agentId: "claude",
				sessionInstanceId: "process-1",
			}),
		});
		const emissions: string[] = [];
		store.onChange((summary) => {
			emissions.push(
				`${summary.state}:${summary.outstandingInteraction?.status ?? "none"}:${summary.latestHookActivity?.hookEventName ?? "none"}`,
			);
		});

		store.applySessionEvent("task-1", {
			type: "provider.hook",
			event: "to_review",
			sessionEvidence: "live",
			occurredAt: 100,
			correlatedToolUseId: "tool-1",
			metadata: {
				source: "claude",
				sessionInstanceId: "process-1",
				promptId: "prompt-1",
				hookEventName: "PermissionRequest",
				toolName: "Bash",
			},
		});
		expect(emissions).toEqual(["awaiting_review:waiting:PermissionRequest"]);

		store.applySessionEvent("task-1", {
			type: "provider.hook",
			event: "activity",
			sessionEvidence: "live",
			occurredAt: 110,
			metadata: {
				source: "claude",
				sessionInstanceId: "process-1",
				promptId: "prompt-1",
				hookEventName: "PreToolUse",
				toolName: "Read",
				toolUseId: "tool-2",
			},
		});

		const summary = store.getSummary("task-1");
		expect(summary?.outstandingInteraction).toMatchObject({ status: "waiting", toolUseId: "tool-1" });
		expect(summary?.latestHookActivity?.hookEventName).toBe("PermissionRequest");
		// Provider ordering is committed separately by TerminalSessionManager.
		// The semantic reducer therefore emits nothing for this unrelated hook.
		expect(emissions).toHaveLength(1);
	});

	it("persists provider occurrence order separately from the local hook activity clock", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({
				taskId: "task-1",
				state: "running",
				agentId: "codex",
				sessionInstanceId: "process-1",
			}),
		});

		store.applySessionEvent("task-1", {
			type: "provider.hook",
			event: "activity",
			sessionEvidence: "live",
			occurredAt: 100,
			deliveryId: "00000000-0000-4000-8000-000000000001",
			metadata: {
				source: "codex",
				sessionInstanceId: "process-1",
				hookEventName: "PreToolUse",
				turnId: "turn-1",
				toolName: "Read",
			},
		});
		store.recordProviderHookReceipt("task-1", {
			event: "activity",
			deliveryId: "00000000-0000-4000-8000-000000000001",
			occurredAt: 100,
			source: "codex",
			sessionInstanceId: "process-1",
			hookEventName: "PreToolUse",
			notificationType: null,
			turnId: "turn-1",
			promptId: null,
			toolUseId: null,
			elicitationId: null,
			toolName: "Read",
		});

		const summary = store.getSummary("task-1");
		expect(summary?.lastProviderHookOccurredAt).toBe(100);
		expect(summary?.recentProviderHookDeliveryIds).toEqual(["00000000-0000-4000-8000-000000000001"]);
		expect(summary?.recentProviderHookOrderObservations).toHaveLength(1);
		expect(summary?.lastHookAt).toEqual(expect.any(Number));
		expect(summary?.lastHookAt).not.toBe(100);
	});

	it("returns deep snapshots so callers cannot mutate persisted interaction identity", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({
				taskId: "task-1",
				state: "awaiting_review",
				reviewReason: "hook",
				outstandingInteraction: {
					provider: "codex",
					kind: "permission",
					status: "waiting",
					requestEventName: "PermissionRequest",
					openedAt: 1,
					updatedAt: 1,
					responseSubmittedAt: null,
					responseKind: null,
					sessionInstanceId: "process-1",
					providerSessionId: "session-1",
					turnId: "turn-1",
					promptId: null,
					toolUseId: "tool-1",
					elicitationId: null,
					providerAgentId: null,
					toolName: "Bash",
				},
			}),
		});

		const snapshot = store.getSummary("task-1");
		if (!snapshot?.outstandingInteraction) throw new Error("Expected interaction snapshot.");
		snapshot.outstandingInteraction.status = "resolution_unknown";
		snapshot.recentProviderHookDeliveryIds.push("00000000-0000-4000-8000-000000000099");
		snapshot.recentProviderHookOrderObservations.push({
			event: "activity",
			deliveryId: "00000000-0000-4000-8000-000000000098",
			occurredAt: 2,
			source: "codex",
			sessionInstanceId: "process-1",
			hookEventName: "PostToolUse",
			notificationType: null,
			turnId: "turn-1",
			promptId: null,
			toolUseId: null,
			elicitationId: null,
			toolName: "Bash",
		});

		expect(store.getSummary("task-1")?.outstandingInteraction?.status).toBe("waiting");
		expect(store.getSummary("task-1")?.recentProviderHookDeliveryIds).toEqual([]);
		expect(store.getSummary("task-1")?.recentProviderHookOrderObservations).toEqual([]);
	});
});
