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
			projectId: "project-1",
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
			update: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		});

		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "activity",
			metadata: {
				source: "claude",
				activityText: "Using Read",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).transitionToRunning).not.toHaveBeenCalled();
		expect(mockStore(manager).transitionToReview).not.toHaveBeenCalled();
		expect(mockStore(manager).applyHookActivity).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				source: "claude",
				activityText: "Using Read",
				toolInputSummary: null,
				conversationSummaryText: null,
			}),
		);
	});

	it("persists a resumable session id without mutating hook activity", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex", resumeSessionId: null })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookMetadata: vi.fn(),
			applyHookActivity: vi.fn(),
		});

		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "activity",
			metadata: {
				source: "codex",
				hookEventName: "session_meta",
				sessionId: "019d6fa0-db65-7f83-9531-35df54674d76",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).applyHookMetadata).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				source: "codex",
				hookEventName: "session_meta",
				sessionId: "019d6fa0-db65-7f83-9531-35df54674d76",
			}),
		);
		expect(mockStore(manager).applyHookActivity).not.toHaveBeenCalled();
	});

	it("emits the structured review follow-up broadcasts on to_review transitions", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});
		const broadcaster = {
			broadcastRuntimeProjectStateUpdated: vi.fn(async () => undefined),
			broadcastTaskReadyForReview: vi.fn(),
		};

		const api = createTestApi(manager, { broadcaster });

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
		});

		expect(response).toEqual({ ok: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(broadcaster.broadcastRuntimeProjectStateUpdated).toHaveBeenCalledWith("project-1", "/tmp/repo");
		expect(broadcaster.broadcastTaskReadyForReview).toHaveBeenCalledWith("project-1", "task-1");
	});
});
