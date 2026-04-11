import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { isPermissionActivity } from "../../../src/terminal/session-reconciliation";
import type { SessionSummaryStore } from "../../../src/terminal/session-summary-store";
import { createHooksApi } from "../../../src/trpc/hooks-api";

function createMockManager(storeMethods: Partial<SessionSummaryStore>): TerminalSessionManager {
	return { store: storeMethods } as unknown as TerminalSessionManager;
}

/** Access the mock store's methods for assertions. */
function mockStore(manager: TerminalSessionManager): Record<string, ReturnType<typeof vi.fn>> {
	return manager.store as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function permissionActivity(overrides: Partial<RuntimeTaskHookActivity> = {}): RuntimeTaskHookActivity {
	return {
		hookEventName: "PermissionRequest",
		notificationType: null,
		activityText: "Waiting for approval",
		toolName: null,
		toolInputSummary: null,
		finalMessage: null,
		source: "claude",
		conversationSummaryText: null,
		...overrides,
	};
}

function nullFilledActivity(partial: Partial<RuntimeTaskHookActivity>): RuntimeTaskHookActivity {
	return {
		hookEventName: partial.hookEventName ?? null,
		notificationType: partial.notificationType ?? null,
		activityText: partial.activityText ?? null,
		toolName: partial.toolName ?? null,
		toolInputSummary: partial.toolInputSummary ?? null,
		finalMessage: partial.finalMessage ?? null,
		source: partial.source ?? null,
		conversationSummaryText: partial.conversationSummaryText ?? null,
	};
}

describe("createHooksApi", () => {
	it("treats ineligible hook transitions as successful no-ops", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
		});

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).transitionToRunning).not.toHaveBeenCalled();
		expect(mockStore(manager).transitionToReview).not.toHaveBeenCalled();
	});

	it("stores activity metadata without changing session state", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		});

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: {
				source: "claude",
				activityText: "Using Read",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).transitionToRunning).not.toHaveBeenCalled();
		expect(mockStore(manager).transitionToReview).not.toHaveBeenCalled();
		expect(mockStore(manager).applyHookActivity).toHaveBeenCalledWith("task-1", {
			source: "claude",
			activityText: "Using Read",
			hookEventName: undefined,
			toolName: undefined,
			toolInputSummary: null,
			finalMessage: undefined,
			notificationType: undefined,
			conversationSummaryText: null,
		});
	});

	it("calls appendConversationSummary when conversationSummaryText is present", async () => {
		const appendConversationSummary = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		});

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: {
				conversationSummaryText: "Completed the auth refactor with tests",
			},
		});

		expect(appendConversationSummary).toHaveBeenCalledWith("task-1", {
			text: "Completed the auth refactor with tests",
			capturedAt: expect.any(Number),
		});
	});

	it("falls back to setDisplaySummary from finalMessage when no conversationSummaryText", async () => {
		const setDisplaySummary = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary,
		});

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: {
				finalMessage: "Done with the work",
			},
		});

		expect(setDisplaySummary).toHaveBeenCalledWith("task-1", "Done with the work", null);
	});

	it("truncates long finalMessage to 80 chars with ellipsis in setDisplaySummary", async () => {
		const setDisplaySummary = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary,
		});

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const longMessage = "A".repeat(100);
		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: {
				finalMessage: longMessage,
			},
		});

		expect(setDisplaySummary).toHaveBeenCalledTimes(1);
		const displayArg = setDisplaySummary.mock.calls[0][1] as string;
		expect(displayArg.length).toBe(91); // 90 + ellipsis
		expect(displayArg.endsWith("\u2026")).toBe(true);
	});

	it("does not call summary methods when neither conversationSummaryText nor finalMessage is present", async () => {
		const appendConversationSummary = vi.fn();
		const setDisplaySummary = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary,
			setDisplaySummary,
		});

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: {
				source: "claude",
				activityText: "Working on it",
			},
		});

		expect(appendConversationSummary).not.toHaveBeenCalled();
		expect(setDisplaySummary).not.toHaveBeenCalled();
	});

	it("applies summary on the to_review transition path as well", async () => {
		const appendConversationSummary = vi.fn();
		const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		});

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: {
				conversationSummaryText: "Finished implementing feature",
			},
		});

		expect(appendConversationSummary).toHaveBeenCalledWith("task-1", {
			text: "Finished implementing feature",
			capturedAt: expect.any(Number),
		});
	});

	// ── Permission metadata guard ────────────────────────────────────────────

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

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { hookEventName: "Stop", activityText: "Final: done", source: "claude" },
		});

		expect(response).toEqual({ ok: true });
		// Guard blocks applyHookActivity — Stop can't clobber permission metadata
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

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

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

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { hookEventName: "Notification", source: "claude" },
		});

		// Non-permission existing activity → guard does not block
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

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { notificationType: "permission_prompt", activityText: "Allow bash?", source: "claude" },
		});

		// Permission-on-permission → guard allows through
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

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

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

		// applyHookActivity blocked, but conversation summary still captured
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
					latestHookActivity: permissionActivity(), // stale permission activity on running task
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: { hookEventName: "PreToolUse", toolName: "bash", source: "claude" },
		});

		// Task is running, not awaiting_review → guard does not fire
		expect(mockStore(manager).applyHookActivity).toHaveBeenCalledWith("task-1", expect.any(Object));
	});

	it("permission request followed by approval transitions card correctly (happy path)", async () => {
		// Step 1: PermissionRequest → to_review → awaiting_review
		const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const runningSummary = createSummary({ state: "running" });
		const manager = createMockManager({
			getSummary: vi
				.fn<() => RuntimeTaskSessionSummary>()
				.mockReturnValueOnce(createSummary({ state: "running" })) // first call: running
				.mockReturnValueOnce(
					createSummary({
						state: "awaiting_review",
						reviewReason: "hook",
						latestHookActivity: permissionActivity(),
					}),
				), // second call: awaiting_review
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(() => runningSummary),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const broadcastTaskReadyForReview = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
				commit: "aaa",
				createdAt: Date.now(),
			})),
			deleteTaskTurnCheckpointRef: vi.fn(async () => undefined),
		});

		// PermissionRequest hook
		const r1 = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { hookEventName: "PermissionRequest", source: "claude" },
		});
		expect(r1).toEqual({ ok: true });
		expect(mockStore(manager).transitionToReview).toHaveBeenCalledWith("task-1", "hook");
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith("workspace-1", "task-1");

		// Step 2: PostToolUse → to_in_progress → running
		const r2 = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude" },
		});
		expect(r2).toEqual({ ok: true });
		expect(mockStore(manager).transitionToRunning).toHaveBeenCalledWith("task-1");
	});

	it("captures a turn checkpoint when transitioning to review", async () => {
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			latestTurnCheckpoint: {
				turn: 2,
				ref: "refs/quarterdeck/checkpoints/task-1/turn/2",
				commit: "2222222",
				createdAt: 1,
			},
			previousTurnCheckpoint: {
				turn: 1,
				ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			},
		});

		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		});

		const captureTaskTurnCheckpoint = vi.fn(async () => ({
			turn: 3,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/3",
			commit: "3333333",
			createdAt: Date.now(),
		}));
		const deleteTaskTurnCheckpointRef = vi.fn(async () => undefined);

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
		});

		expect(response).toEqual({ ok: true });
		expect(captureTaskTurnCheckpoint).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			turn: 3,
		});
		expect(mockStore(manager).applyTurnCheckpoint).toHaveBeenCalledTimes(1);
		expect(deleteTaskTurnCheckpointRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
		});
	});
});

// ── isPermissionActivity with null-filled partial metadata ──────────────

describe("isPermissionActivity with null-filled partial metadata", () => {
	it("detects PermissionRequest from partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({ hookEventName: "PermissionRequest" }))).toBe(true);
	});

	it("detects permission_prompt from partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({ notificationType: "permission_prompt" }))).toBe(true);
	});

	it("detects permission.asked from partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({ notificationType: "permission.asked" }))).toBe(true);
	});

	it("detects 'Waiting for approval' activityText from partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({ activityText: "Waiting for approval" }))).toBe(true);
	});

	it("returns false for Stop from partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({ hookEventName: "Stop" }))).toBe(false);
	});

	it("returns false for all-null partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({}))).toBe(false);
	});
});
