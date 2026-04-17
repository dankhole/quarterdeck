import { describe, expect, it, vi } from "vitest";

import { createMockManager, createSummary, createTestApi, mockStore } from "./_helpers";

describe("createHooksApi — turn checkpoints", () => {
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

		const api = createTestApi(manager, {
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef,
		});

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "workspace-1",
			event: "to_review",
		});

		expect(response).toEqual({ ok: true });
		await new Promise((r) => setTimeout(r, 0));
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

	it("applies hook activity before checkpoint capture on to_review transition", async () => {
		const callOrder: string[] = [];
		const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(() => {
				callOrder.push("applyHookActivity");
				return transitionedSummary;
			}),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const captureTaskTurnCheckpoint = vi.fn(async () => {
			callOrder.push("captureTaskTurnCheckpoint");
			return {
				turn: 1,
				ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
				commit: "aaa",
				createdAt: Date.now(),
			};
		});

		const api = createTestApi(manager, {
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef: vi.fn(async () => undefined),
		});

		await api.ingest({
			taskId: "task-1",
			projectId: "workspace-1",
			event: "to_review",
			metadata: { hookEventName: "Stop", activityText: "Done with work", source: "claude" },
		});

		expect(callOrder).toEqual(["applyHookActivity", "captureTaskTurnCheckpoint"]);
	});
});
