import { describe, expect, it, vi } from "vitest";

import { createMockManager, createSummary, createTestApi, mockStore } from "./_helpers";

describe("createHooksApi — agent session persistence", () => {
	it("passes an incoming session id through the atomic hook transition", async () => {
		const update = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", resumeSessionId: null })),
			update,
			applyHookMetadata: vi.fn(),
			toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
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
		expect(manager.applyHookTransition).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				type: "hook.to_review",
				reason: "hook",
				metadata: expect.objectContaining({
					hookEventName: "PermissionRequest",
					source: "codex",
					sessionId: "codex-session-123",
				}),
			}),
		);
		expect(mockStore(manager).applyHookMetadata).not.toHaveBeenCalled();
	});
});
