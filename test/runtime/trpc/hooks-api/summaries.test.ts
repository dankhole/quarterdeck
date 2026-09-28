import { describe, expect, it, vi } from "vitest";

import { InMemorySessionSummaryStore } from "../../../../src/terminal";

import { createMockManager, createSummary, createTestApi } from "./_helpers";

describe("createHooksApi — conversation summaries", () => {
	it("calls appendConversationSummary when conversationSummaryText is present", async () => {
		const appendConversationSummary = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
			metadata: {
				source: "claude",
				hookEventName: "Stop",
				conversationSummaryText: "Completed the auth refactor with tests",
			},
		});

		expect(appendConversationSummary).toHaveBeenCalledWith("task-1", {
			text: "Completed the auth refactor with tests",
			capturedAt: expect.any(Number),
		});
	});

	it.each(["codex", "claude", "pi"] as const)(
		"retains the latest %s final response after subsequent hooks clear transient activity",
		async (agentId) => {
			const store = new InMemorySessionSummaryStore();
			store.ensureEntry("task-1");
			store.update(
				"task-1",
				createSummary({ agentId, sessionInstanceId: "launch-1", state: "awaiting_review", reviewReason: "hook" }),
			);
			store.appendConversationSummary("task-1", { text: "Older response", capturedAt: 1 });
			const manager = createMockManager({
				getSummary: store.getSummary.bind(store),
				appendConversationSummary: store.appendConversationSummary.bind(store),
			});
			manager.applyProviderHook = vi.fn((taskId, input) =>
				store.applySessionEvent(taskId, {
					type: "provider.hook",
					event: input.event,
					metadata: input.metadata,
					sessionEvidence: "live",
				}),
			);
			const api = createTestApi(manager);
			const finalMessage = "The latest response with enough detail to fill the card. ".repeat(7);
			await api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: agentId,
					sessionInstanceId: "launch-1",
					hookEventName: agentId === "pi" ? "AgentSettled" : "Stop",
					finalMessage,
					conversationSummaryText: "A shorter synopsis",
				},
			});
			expect(store.getSummary("task-1")?.conversationSummaries.at(-1)?.text).toBe(finalMessage.trim());
			await api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_in_progress",
				metadata: { source: agentId, sessionInstanceId: "launch-1", hookEventName: "UserPromptSubmit" },
			});
			const summary = store.getSummary("task-1");
			expect(summary?.latestHookActivity?.finalMessage).toBeNull();
			expect(summary?.conversationSummaries.at(-1)?.text).toBe(finalMessage.trim());
		},
	);

	it("retains finalMessage without requiring conversationSummaryText", async () => {
		const appendConversationSummary = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary()),
			appendConversationSummary,
		});
		await createTestApi(manager).ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "Stop", finalMessage: "Latest response" },
		});
		expect(appendConversationSummary).toHaveBeenCalledWith("task-1", {
			text: "Latest response",
			capturedAt: expect.any(Number),
		});
	});

	it("does not call summary methods when neither conversationSummaryText nor finalMessage is present", async () => {
		const appendConversationSummary = vi.fn();
		const setDisplaySummary = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
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
			toReviewSummary: vi.fn(() => transitionedSummary),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
			metadata: {
				source: "claude",
				hookEventName: "Stop",
				conversationSummaryText: "Finished implementing feature",
			},
		});

		expect(appendConversationSummary).toHaveBeenCalledWith("task-1", {
			text: "Finished implementing feature",
			capturedAt: expect.any(Number),
		});
	});

	it("does not let a Claude subagent completion replace the foreground task summary", async () => {
		const appendConversationSummary = vi.fn();
		const setDisplaySummary = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			appendConversationSummary,
			setDisplaySummary,
		});
		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "activity",
			metadata: {
				source: "claude",
				hookEventName: "SubagentStop",
				providerAgentId: "subagent-1",
				finalMessage: "Subagent-only result",
				conversationSummaryText: "Subagent-only summary",
			},
		});

		expect(appendConversationSummary).not.toHaveBeenCalled();
		expect(setDisplaySummary).not.toHaveBeenCalled();
	});
});
