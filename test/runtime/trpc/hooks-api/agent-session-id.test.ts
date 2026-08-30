import { describe, expect, it, vi } from "vitest";

import { createMockManager, createSummary, createTestApi } from "./_helpers";

describe("createHooksApi — agent session persistence", () => {
	it("records a Claude transcript path only through the admitted server-owned hook hint boundary", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", resumeSessionId: "claude-session-123" })),
			toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});
		const recordClaudeHookHint = vi.fn();
		const api = createTestApi(manager, {
			conversationSourceHints: { recordClaudeHookHint },
			captureTaskTurnCheckpoint: vi.fn(() =>
				Promise.resolve({ turn: 1, ref: "refs/quarterdeck/checkpoint", commit: "abc123", createdAt: 1 }),
			),
		});
		const metadata = {
			hookEventName: "Stop",
			source: "claude",
			sessionId: "claude-session-123",
			transcriptPath: "/untrusted/.claude/projects/task/claude-session-123.jsonl",
		};

		await expect(
			api.ingest({ taskId: "task-1", projectId: "project-1", event: "to_review", metadata }),
		).resolves.toEqual({ ok: true });
		expect(recordClaudeHookHint).toHaveBeenCalledWith({
			projectId: "project-1",
			taskId: "task-1",
			expectedProviderSessionId: "claude-session-123",
			metadata: expect.objectContaining(metadata),
		});
	});

	it("passes an incoming session id through the atomic hook transition", async () => {
		const update = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex", resumeSessionId: null })),
			update,
			toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});

		const api = createTestApi(manager, {
			captureTaskTurnCheckpoint: vi.fn(() =>
				Promise.resolve({ turn: 1, ref: "refs/quarterdeck/checkpoint", commit: "abc123", createdAt: 1 }),
			),
		});

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
		expect(manager.applyProviderHook).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				event: "to_review",
				metadata: expect.objectContaining({
					hookEventName: "PermissionRequest",
					source: "codex",
					sessionId: "codex-session-123",
				}),
			}),
		);
	});
});
