import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createHooksApi } from "../../../src/trpc/hooks-api";

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
		...overrides,
	};
}

describe("createHooksApi", () => {
	it("treats ineligible hook transitions as successful no-ops", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
		} as unknown as TerminalSessionManager;

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
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
	});

	it("stores activity metadata without changing session state", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

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
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(manager.applyHookActivity).toHaveBeenCalledWith("task-1", {
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
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		} as unknown as TerminalSessionManager;

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
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary,
		} as unknown as TerminalSessionManager;

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
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary,
		} as unknown as TerminalSessionManager;

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
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary,
			setDisplaySummary,
		} as unknown as TerminalSessionManager;

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
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		} as unknown as TerminalSessionManager;

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

		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

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
		expect(manager.applyTurnCheckpoint).toHaveBeenCalledTimes(1);
		expect(deleteTaskTurnCheckpointRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
		});
	});
});
