import { describe, expect, it, vi } from "vitest";

import { createMockManager, createSummary, createTestApi, mockStore } from "./_helpers";

describe("createHooksApi — agent session persistence", () => {
	it("persists an incoming sessionId via applyHookMetadata only (no separate store.update)", async () => {
		const update = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", resumeSessionId: null })),
			update,
			applyHookMetadata: vi.fn(),
			transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
			metadata: {
				hookEventName: "PermissionRequest",
				source: "codex",
				sessionId: "codex-session-123",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(update).not.toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ resumeSessionId: expect.anything() }),
		);
		expect(mockStore(manager).applyHookMetadata).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				hookEventName: "PermissionRequest",
				source: "codex",
				sessionId: "codex-session-123",
			}),
		);
		expect(mockStore(manager).transitionToReview).toHaveBeenCalledWith("task-1", "hook");
	});
});
