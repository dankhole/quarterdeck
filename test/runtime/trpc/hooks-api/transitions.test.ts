import { describe, expect, it, vi } from "vitest";

import { createMockManager, createSummary, createTestApi, mockStore } from "./_helpers";

describe("createHooksApi — transitions", () => {
	it("treats ineligible hook transitions as successful no-ops", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
		});

		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "workspace-1",
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

		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "workspace-1",
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
});
