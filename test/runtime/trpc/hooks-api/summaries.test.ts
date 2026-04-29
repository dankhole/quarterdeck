import { describe, expect, it, vi } from "vitest";

import { createMockManager, createSummary, createTestApi } from "./_helpers";

describe("createHooksApi — conversation summaries", () => {
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

		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
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

		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_in_progress",
			metadata: {
				finalMessage: "Done with the work",
			},
		});

		expect(setDisplaySummary).toHaveBeenCalledWith("task-1", "Done with the work", null);
	});

	it("truncates long finalMessage to 90 chars with ellipsis in setDisplaySummary", async () => {
		const setDisplaySummary = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary,
		});

		const api = createTestApi(manager);

		const longMessage = "A".repeat(100);
		await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
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

		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
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

		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
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
});
