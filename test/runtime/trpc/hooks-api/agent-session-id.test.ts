import { describe, expect, it, vi } from "vitest";

import { ConversationSourceHintStore } from "../../../../src/conversation";

import { createMockManager, createSummary, createTestApi } from "./_helpers";

describe("createHooksApi — agent session persistence", () => {
	it.each(["claude", "codex"] as const)(
		"records a %s transcript path only through the admitted server-owned hook hint boundary",
		async (agentId) => {
			const manager = createMockManager({
				getSummary: vi.fn(() =>
					createSummary({ agentId, state: "running", resumeSessionId: "claude-session-123" }),
				),
				toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
				appendCompletedResponse: vi.fn(),
			});
			const recordProviderHookHint = vi.fn();
			const api = createTestApi(manager, {
				conversationSourceHints: { recordProviderHookHint },
			});
			const metadata = {
				hookEventName: "Stop",
				source: agentId,
				sessionId: "claude-session-123",
				transcriptPath: "/untrusted/.claude/projects/task/claude-session-123.jsonl",
			};

			await expect(
				api.ingest({ taskId: "task-1", projectId: "project-1", event: "to_review", metadata }),
			).resolves.toEqual({ ok: true });
			expect(recordProviderHookHint).toHaveBeenCalledWith({
				projectId: "project-1",
				taskId: "task-1",
				expectedProviderSessionId: "claude-session-123",
				metadata: expect.objectContaining(metadata),
			});
		},
	);

	it.each(["previous-launch", undefined])(
		"does not replace a current Pi source with an ordering-admitted %s launch",
		async (sessionInstanceId) => {
			const manager = createMockManager({
				getSummary: vi.fn(() =>
					createSummary({
						agentId: "pi",
						state: "running",
						sessionInstanceId: "launch-1",
						resumeSessionId: "pi-session-1",
					}),
				),
			});
			const hints = new ConversationSourceHintStore();
			const record = vi.spyOn(hints, "recordProviderHookHint");
			const api = createTestApi(manager, { conversationSourceHints: hints });
			const metadata = {
				source: "pi",
				hookEventName: "AgentStart",
				sessionId: "pi-session-1",
				sessionInstanceId: "launch-1",
				transcriptPath: "/current/pi-session-1.jsonl",
			};
			await expect(
				api.ingest({ taskId: "task-1", projectId: "project-1", event: "to_in_progress", metadata }),
			).resolves.toEqual({ ok: true });
			const current = hints.getHint("project-1", "task-1", "pi-session-1");
			expect(current?.sourcePath).toBe(metadata.transcriptPath);
			await expect(
				api.ingest({
					taskId: "task-1",
					projectId: "project-1",
					event: "activity",
					metadata: { ...metadata, sessionInstanceId, transcriptPath: "/previous/pi-session-1.jsonl" },
				}),
			).resolves.toEqual({ ok: true });
			expect(manager.evaluateHookEventOrder).toHaveLastReturnedWith({ accepted: true });
			expect(record).toHaveBeenCalledOnce();
			expect(hints.getHint("project-1", "task-1", "pi-session-1")).toEqual(current);
		},
	);

	it("does not record a subagent transcript as the task conversation source", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ agentId: "codex", state: "running", resumeSessionId: "codex-root" })),
			appendCompletedResponse: vi.fn(),
		});
		const recordProviderHookHint = vi.fn();
		const api = createTestApi(manager, { conversationSourceHints: { recordProviderHookHint } });

		await expect(
			api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_in_progress",
				metadata: {
					hookEventName: "PostToolUse",
					source: "codex",
					sessionId: "codex-root",
					providerAgentId: "codex-child",
					transcriptPath: "/untrusted/.codex/sessions/child.jsonl",
				},
			}),
		).resolves.toEqual({ ok: true });
		expect(recordProviderHookHint).not.toHaveBeenCalled();
	});

	it("passes an incoming session id through the atomic hook transition", async () => {
		const update = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex", resumeSessionId: null })),
			update,
			toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			appendCompletedResponse: vi.fn(),
		});

		const api = createTestApi(manager, {});

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
