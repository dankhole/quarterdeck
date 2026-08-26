import { describe, expect, it, vi } from "vitest";

import { createMockManager, createSummary, createTestApi } from "./_helpers";

describe("createHooksApi — canonical provider routing", () => {
	it("acknowledges a semantic hook only after session persistence completes", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
		});
		let releasePersistence!: () => void;
		const persistence = new Promise<void>((resolve) => {
			releasePersistence = resolve;
		});
		const persistSessionState = vi.fn(async () => await persistence);
		const api = createTestApi(manager, { persistSessionState });
		let settled = false;
		const response = api
			.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: "codex",
					hookEventName: "Stop",
					sessionInstanceId: "process-1",
					turnId: "turn-1",
				},
				delivery: {
					id: "00000000-0000-4000-8000-000000000099",
					occurredAt: 100,
				},
			})
			.then((result) => {
				settled = true;
				return result;
			});

		await vi.waitFor(() => expect(persistSessionState).toHaveBeenCalledWith("project-1"));
		expect(settled).toBe(false);
		releasePersistence();
		await expect(response).resolves.toEqual({ ok: true });
	});

	it("rejects hook acknowledgement when durable session persistence fails", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
		});
		const api = createTestApi(manager, {
			persistSessionState: vi.fn(async () => {
				throw new Error("session persistence failed");
			}),
		});

		await expect(
			api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: "codex",
					hookEventName: "Stop",
					sessionInstanceId: "process-1",
					turnId: "turn-1",
				},
			}),
		).resolves.toEqual({ ok: false, error: "session persistence failed" });
	});

	it.each([
		["stale_observation", false],
		["unrelated_tool_completion", true],
	] as const)("acknowledges %s without applying task meaning", async (reason, commitObservation) => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
		});
		vi.mocked(manager.evaluateHookEventOrder).mockReturnValue({ accepted: false, reason });
		const api = createTestApi(manager);

		await expect(
			api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: "codex",
					hookEventName: "PermissionRequest",
					sessionInstanceId: "process-1",
					turnId: "turn-1",
				},
				delivery: {
					id: "00000000-0000-4000-8000-000000000001",
					occurredAt: 100,
				},
			}),
		).resolves.toEqual({ ok: true });

		expect(manager.applyProviderHook).not.toHaveBeenCalled();
		expect(manager.recordHookReceived).not.toHaveBeenCalled();
		expect(manager.commitHookEventOrder).toHaveBeenCalledWith("task-1", expect.any(Object), commitObservation);
	});

	it("rejects a hook from a provider that does not own the active task", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
		});
		const api = createTestApi(manager);
		const input = {
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review" as const,
			metadata: {
				source: "codex",
				hookEventName: "Stop",
				sessionInstanceId: "process-1",
			},
		};

		await expect(api.ingest(input)).resolves.toEqual({ ok: true });
		expect(manager.evaluateHookEventOrder).not.toHaveBeenCalled();
		expect(manager.observeTaskSessionLaunchHook).not.toHaveBeenCalled();
		expect(manager.applyProviderHook).not.toHaveBeenCalled();
		expect(manager.commitHookEventOrder).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ metadata: expect.objectContaining(input.metadata) }),
			false,
		);
	});

	it("does not persist an event from an unexpected resumed conversation", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					agentId: "codex",
					resumeSessionId: "expected-session",
				}),
			),
		});
		vi.mocked(manager.observeTaskSessionLaunchHook).mockReturnValue(false);
		const api = createTestApi(manager);

		await expect(
			api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "activity",
				metadata: {
					source: "codex",
					hookEventName: "SessionStart",
					sessionInstanceId: "launch-1",
					sessionId: "wrong-session",
				},
			}),
		).resolves.toEqual({ ok: true });

		expect(manager.applyProviderHook).not.toHaveBeenCalled();
		expect(manager.commitHookEventOrder).toHaveBeenCalledWith("task-1", expect.any(Object), false);
	});

	it("passes the raw provider event and delivery identity to the single transition entry point", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
		});
		const api = createTestApi(manager);
		const input = {
			taskId: "task-1",
			projectId: "project-1",
			event: "activity" as const,
			metadata: {
				source: "claude",
				hookEventName: "PreToolUse",
				sessionInstanceId: "process-1",
				promptId: "prompt-1",
				toolUseId: "tool-1",
				toolName: "Read",
			},
			delivery: {
				id: "00000000-0000-4000-8000-000000000002",
				occurredAt: 200,
			},
		};

		await expect(api.ingest(input)).resolves.toEqual({ ok: true });
		expect(manager.applyProviderHook).toHaveBeenCalledOnce();
		expect(manager.applyProviderHook).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				event: "activity",
				metadata: expect.objectContaining({
					hookEventName: "PreToolUse",
					promptId: "prompt-1",
					toolUseId: "tool-1",
				}),
				delivery: input.delivery,
			}),
		);
		expect(manager.commitHookEventOrder).toHaveBeenCalledWith("task-1", expect.any(Object), true);
	});

	it("treats an accepted but semantically ineligible event as a successful no-op", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
		});
		const api = createTestApi(manager);

		await expect(
			api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_in_progress",
				metadata: { source: "claude", hookEventName: "PostToolUse" },
			}),
		).resolves.toEqual({ ok: true });

		expect(manager.applyProviderHook).toHaveBeenCalledOnce();
		expect(manager.commitHookEventOrder).toHaveBeenCalledWith("task-1", expect.any(Object), false);
	});

	it("captures a checkpoint for an ordinary completed Review transition", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
			toReviewSummary: vi.fn(() =>
				createSummary({ state: "awaiting_review", reviewReason: "hook", agentId: "codex" }),
			),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		});
		const captureTaskTurnCheckpoint = vi.fn(async () => ({
			turn: 1,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
			commit: "abc123",
			createdAt: 100,
		}));
		const api = createTestApi(manager, {
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef: vi.fn(async () => undefined),
			scheduleHookBackgroundTask: (task) => task(),
		});

		await expect(
			api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: { source: "codex", hookEventName: "Stop", turnId: "turn-1" },
			}),
		).resolves.toEqual({ ok: true });
		await vi.waitFor(() => expect(captureTaskTurnCheckpoint).toHaveBeenCalledOnce());
	});
});
