import { describe, expect, it, vi } from "vitest";

import type { RuntimeHookEvent, RuntimeHookMetadata } from "../../../src/core";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../src/terminal";
import { createHooksApi } from "../../../src/trpc";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

function createHarness(agentId: "codex" | "claude") {
	const taskId = `recovered-${agentId}`;
	const sessionInstanceId = `${agentId}-process-1`;
	const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
	manager.hydrateFromRecord({
		[taskId]: createTestTaskSessionSummary({
			taskId,
			agentId,
			sessionInstanceId,
			state: "running",
			reviewReason: null,
			pid: 4321,
			// A later non-hook store write must not make a delayed provider event stale.
			updatedAt: 300,
			lastHookAt: 300,
			lastProviderHookOccurredAt: 100,
			startupRecoveryRequired: true,
		}),
	});
	const persistSessionState = vi.fn(async () => undefined);
	const api = createHooksApi({
		projects: { getProjectPathById: () => "/tmp/repo" },
		terminals: {
			getTerminalManagerForProject: () => manager,
			ensureTerminalManagerForProject: async () => manager,
		},
		persistSessionState,
	});
	let deliveryIndex = 0;
	const ingest = async (event: RuntimeHookEvent, metadata: RuntimeHookMetadata, occurredAt: number) => {
		deliveryIndex += 1;
		return await api.ingest({
			taskId,
			projectId: "project-1",
			event,
			metadata: { source: agentId, sessionInstanceId, ...metadata },
			delivery: {
				id: `00000000-0000-4000-8000-${String(deliveryIndex).padStart(12, "0")}`,
				occurredAt,
			},
		});
	};
	return { taskId, manager, ingest, persistSessionState };
}

describe("persisted hook replay before startup recovery", () => {
	it("restores an unacknowledged completion without claiming a process is running", async () => {
		const { taskId, manager, ingest, persistSessionState } = createHarness("codex");

		await expect(ingest("to_review", { hookEventName: "Stop", turnId: "turn-1" }, 200)).resolves.toEqual({
			ok: true,
		});
		expect(manager.store.getSummary(taskId)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			startupRecoveryRequired: false,
		});
		expect(persistSessionState).toHaveBeenCalledWith("project-1");
	});

	it("keeps recovered work evidence Interrupted until a replacement launch proves resumption", async () => {
		const { taskId, manager, ingest } = createHarness("codex");

		await ingest(
			"to_in_progress",
			{ hookEventName: "PostToolUse", turnId: "turn-1", toolUseId: "tool-1", toolName: "Bash" },
			200,
		);
		expect(manager.store.getSummary(taskId)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			startupRecoveryRequired: true,
		});
	});

	it("rebuilds Claude tool correlation before recovering a permission wait", async () => {
		const { taskId, manager, ingest } = createHarness("claude");

		await ingest(
			"to_in_progress",
			{ hookEventName: "PreToolUse", promptId: "prompt-1", toolUseId: "tool-1", toolName: "Bash" },
			150,
		);
		await ingest("to_review", { hookEventName: "PermissionRequest", promptId: "prompt-1", toolName: "Bash" }, 200);

		expect(manager.store.getSummary(taskId)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			startupRecoveryRequired: true,
			outstandingInteraction: {
				provider: "claude",
				status: "waiting",
				promptId: "prompt-1",
				toolUseId: "tool-1",
			},
		});
	});

	it("rebuilds persisted Claude PreToolUse identity across a second runtime", async () => {
		const taskId = "recovered-claude-cold-correlation";
		const sessionInstanceId = "claude-process-cold-correlation";
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			[taskId]: createTestTaskSessionSummary({
				taskId,
				agentId: "claude",
				sessionInstanceId,
				state: "running",
				pid: 4321,
				lastProviderHookOccurredAt: 150,
				recentProviderHookOrderObservations: [
					{
						event: "to_in_progress",
						deliveryId: "00000000-0000-4000-8000-000000000501",
						occurredAt: 150,
						source: "claude",
						sessionInstanceId,
						hookEventName: "PreToolUse",
						notificationType: null,
						turnId: null,
						promptId: "prompt-1",
						toolUseId: "tool-1",
						elicitationId: null,
						toolName: "Bash",
					},
				],
				startupRecoveryRequired: true,
			}),
		});
		const api = createHooksApi({
			projects: { getProjectPathById: () => "/tmp/repo" },
			terminals: {
				getTerminalManagerForProject: () => manager,
				ensureTerminalManagerForProject: async () => manager,
			},
		});

		await expect(
			api.ingest({
				taskId,
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: "claude",
					sessionInstanceId,
					promptId: "prompt-1",
					hookEventName: "PermissionRequest",
					toolName: "Bash",
				},
				delivery: { id: "00000000-0000-4000-8000-000000000502", occurredAt: 200 },
			}),
		).resolves.toEqual({ ok: true });
		expect(manager.store.getSummary(taskId)?.outstandingInteraction).toMatchObject({
			status: "waiting",
			toolUseId: "tool-1",
		});
	});

	it("accepts an older permission when newer durable evidence belongs to a different tool", async () => {
		const taskId = "recovered-codex-independent-tools";
		const sessionInstanceId = "codex-process-independent-tools";
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			[taskId]: createTestTaskSessionSummary({
				taskId,
				agentId: "codex",
				sessionInstanceId,
				state: "running",
				pid: 4321,
				lastProviderHookOccurredAt: 200,
				recentProviderHookOrderObservations: [
					{
						event: "to_in_progress",
						deliveryId: "00000000-0000-4000-8000-000000000601",
						occurredAt: 200,
						source: "codex",
						sessionInstanceId,
						hookEventName: "PostToolUse",
						notificationType: null,
						turnId: "turn-1",
						promptId: null,
						toolUseId: null,
						elicitationId: null,
						toolName: "Read",
					},
				],
				startupRecoveryRequired: true,
			}),
		});
		const api = createHooksApi({
			projects: { getProjectPathById: () => "/tmp/repo" },
			terminals: {
				getTerminalManagerForProject: () => manager,
				ensureTerminalManagerForProject: async () => manager,
			},
		});

		await api.ingest({
			taskId,
			projectId: "project-1",
			event: "to_review",
			metadata: {
				source: "codex",
				sessionInstanceId,
				turnId: "turn-1",
				hookEventName: "PermissionRequest",
				toolName: "Bash",
			},
			delivery: { id: "00000000-0000-4000-8000-000000000602", occurredAt: 100 },
		});

		expect(manager.store.getSummary(taskId)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			startupRecoveryRequired: true,
			outstandingInteraction: { status: "waiting", toolName: "Bash" },
		});
	});

	it("rejects an older permission when durable evidence completed that same tool", async () => {
		const taskId = "recovered-codex-completed-tool";
		const sessionInstanceId = "codex-process-completed-tool";
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			[taskId]: createTestTaskSessionSummary({
				taskId,
				agentId: "codex",
				sessionInstanceId,
				state: "running",
				pid: 4321,
				lastProviderHookOccurredAt: 200,
				recentProviderHookOrderObservations: [
					{
						event: "to_in_progress",
						deliveryId: "00000000-0000-4000-8000-000000000701",
						occurredAt: 200,
						source: "codex",
						sessionInstanceId,
						hookEventName: "PostToolUse",
						notificationType: null,
						turnId: "turn-1",
						promptId: null,
						toolUseId: null,
						elicitationId: null,
						toolName: "Bash",
					},
				],
				startupRecoveryRequired: true,
			}),
		});
		const api = createHooksApi({
			projects: { getProjectPathById: () => "/tmp/repo" },
			terminals: {
				getTerminalManagerForProject: () => manager,
				ensureTerminalManagerForProject: async () => manager,
			},
		});

		await api.ingest({
			taskId,
			projectId: "project-1",
			event: "to_review",
			metadata: {
				source: "codex",
				sessionInstanceId,
				turnId: "turn-1",
				hookEventName: "PermissionRequest",
				toolName: "Bash",
			},
			delivery: { id: "00000000-0000-4000-8000-000000000702", occurredAt: 100 },
		});

		expect(manager.store.getSummary(taskId)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			outstandingInteraction: null,
		});
	});

	it("uses provider occurrence order rather than the later processing timestamp as the replay boundary", async () => {
		const { taskId, manager, ingest } = createHarness("codex");

		await expect(ingest("to_review", { hookEventName: "Stop", turnId: "turn-1" }, 200)).resolves.toEqual({
			ok: true,
		});
		expect(manager.store.getSummary(taskId)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			startupRecoveryRequired: false,
			lastHookAt: expect.any(Number),
			lastProviderHookOccurredAt: 200,
		});
	});

	it("does not replay an event older than the last durably applied hook", async () => {
		const { taskId, manager, ingest } = createHarness("codex");

		await expect(ingest("to_review", { hookEventName: "Stop", turnId: "turn-1" }, 99)).resolves.toEqual({ ok: true });
		expect(manager.store.getSummary(taskId)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			startupRecoveryRequired: true,
		});
	});

	it("does not replay a delivery already included in the durable summary", async () => {
		const taskId = "recovered-codex-duplicate";
		const sessionInstanceId = "codex-process-duplicate";
		const deliveryId = "00000000-0000-4000-8000-000000000777";
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			[taskId]: createTestTaskSessionSummary({
				taskId,
				agentId: "codex",
				sessionInstanceId,
				state: "running",
				pid: 4321,
				lastProviderHookOccurredAt: 200,
				recentProviderHookDeliveryIds: [deliveryId],
				startupRecoveryRequired: true,
			}),
		});
		const api = createHooksApi({
			projects: { getProjectPathById: () => "/tmp/repo" },
			terminals: {
				getTerminalManagerForProject: () => manager,
				ensureTerminalManagerForProject: async () => manager,
			},
		});

		await expect(
			api.ingest({
				taskId,
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: "codex",
					hookEventName: "PermissionRequest",
					sessionInstanceId,
					turnId: "turn-1",
					toolName: "Bash",
				},
				delivery: { id: deliveryId, occurredAt: 200 },
			}),
		).resolves.toEqual({ ok: true });
		expect(manager.store.getSummary(taskId)).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			outstandingInteraction: null,
		});
	});
});
