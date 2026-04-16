import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../../src/core/api-contract";

import { createMockManager, createSummary, createTestApi, mockStore, permissionActivity } from "./_helpers";

describe("createHooksApi — permission metadata guard", () => {
	it("permission metadata survives Stop hook on non-transition path", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: permissionActivity(),
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { hookEventName: "Stop", activityText: "Final: done", source: "claude" },
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).applyHookActivity).not.toHaveBeenCalled();
	});

	it("permission metadata survives generic activity hook", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: permissionActivity(),
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: { hookEventName: "PreToolUse", toolName: "bash", source: "claude" },
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).applyHookActivity).not.toHaveBeenCalled();
	});

	it("non-permission metadata is still applied on non-transition path", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						hookEventName: "Stop",
						notificationType: null,
						activityText: "Final: done",
						toolName: null,
						toolInputSummary: null,
						finalMessage: "done",
						source: "claude",
						conversationSummaryText: null,
					},
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { hookEventName: "Notification", source: "claude" },
		});

		expect(mockStore(manager).applyHookActivity).toHaveBeenCalledWith("task-1", expect.any(Object));
	});

	it("new permission hook overwrites old permission metadata (permission-on-permission)", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: permissionActivity(),
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { notificationType: "permission_prompt", activityText: "Allow bash?", source: "claude" },
		});

		expect(mockStore(manager).applyHookActivity).toHaveBeenCalledWith("task-1", expect.any(Object));
	});

	it("conversation summary from Stop is still applied even when activity is guarded", async () => {
		const appendConversationSummary = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: permissionActivity(),
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: {
				hookEventName: "Stop",
				conversationSummaryText: "I fixed the bug",
				source: "claude",
			},
		});

		expect(mockStore(manager).applyHookActivity).not.toHaveBeenCalled();
		expect(appendConversationSummary).toHaveBeenCalledWith("task-1", {
			text: "I fixed the bug",
			capturedAt: expect.any(Number),
		});
	});

	it("guard does not fire when task is not in awaiting_review", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "running",
					latestHookActivity: permissionActivity(),
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: { hookEventName: "PreToolUse", toolName: "bash", source: "claude" },
		});

		expect(mockStore(manager).applyHookActivity).toHaveBeenCalledWith("task-1", expect.any(Object));
	});
});

describe("createHooksApi — permission-aware transition guard", () => {
	it("permission request followed by approval transitions card correctly (happy path)", async () => {
		const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const manager = createMockManager({
			getSummary: vi
				.fn<() => RuntimeTaskSessionSummary>()
				.mockReturnValueOnce(createSummary({ state: "running" }))
				.mockReturnValueOnce(
					createSummary({
						state: "running",
						latestHookActivity: null,
					}),
				),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const broadcastTaskReadyForReview = vi.fn();
		const api = createTestApi(manager, {
			broadcaster: { broadcastRuntimeWorkspaceStateUpdated: vi.fn(), broadcastTaskReadyForReview },
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
				commit: "aaa",
				createdAt: Date.now(),
			})),
			deleteTaskTurnCheckpointRef: vi.fn(async () => undefined),
		});

		const r1 = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { hookEventName: "PermissionRequest", source: "claude" },
		});
		expect(r1).toEqual({ ok: true });
		expect(mockStore(manager).transitionToReview).toHaveBeenCalledWith("task-1", "hook");
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith("workspace-1", "task-1");

		const r2 = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { hookEventName: "PostToolUse", source: "claude" },
		});
		expect(r2).toEqual({ ok: true });
		expect(mockStore(manager).transitionToRunning).not.toHaveBeenCalled();
	});

	it("blocks stale PostToolUse from bouncing permission state back to running", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: permissionActivity(),
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { hookEventName: "PostToolUse", toolName: "Bash", source: "claude" },
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).transitionToRunning).not.toHaveBeenCalled();
	});

	it("allows UserPromptSubmit through the permission guard", async () => {
		const runningSummary = createSummary({ state: "running" });
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: permissionActivity(),
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => runningSummary),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const broadcastRuntimeWorkspaceStateUpdated = vi.fn();
		const api = createTestApi(manager, {
			broadcaster: { broadcastRuntimeWorkspaceStateUpdated, broadcastTaskReadyForReview: vi.fn() },
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { hookEventName: "UserPromptSubmit", source: "claude" },
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).transitionToRunning).toHaveBeenCalledWith("task-1");
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalled();
	});

	it("allows to_in_progress through when activity is not permission-related", async () => {
		const runningSummary = createSummary({ state: "running" });
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						hookEventName: "Stop",
						notificationType: null,
						activityText: "Final: done",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						source: "claude",
						conversationSummaryText: null,
					},
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => runningSummary),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { hookEventName: "PostToolUse", toolName: "Bash", source: "claude" },
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).transitionToRunning).toHaveBeenCalledWith("task-1");
	});
});
