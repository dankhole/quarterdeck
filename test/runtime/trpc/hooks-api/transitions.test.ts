import { describe, expect, it, vi } from "vitest";

import { createMockManager, createSummary, createTestApi, mockStore } from "./_helpers";

describe("createHooksApi — transitions", () => {
	it.each([
		["stale_observation", false],
		["unrelated_tool_completion", true],
	] as const)("ignores %s deliveries without touching task state", async (reason, commitObservation) => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
			applyHookActivity: vi.fn(),
		});
		vi.mocked(manager.evaluateHookEventOrder).mockReturnValue({
			accepted: false,
			reason,
		});
		const api = createTestApi(manager);

		const response = await api.ingest({
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
		});

		expect(response).toEqual({ ok: true });
		expect(manager.recordHookReceived).not.toHaveBeenCalled();
		expect(manager.applyHookTransition).not.toHaveBeenCalled();
		expect(manager.observeTaskSessionLaunchHook).not.toHaveBeenCalled();
		expect(manager.commitHookEventOrder).toHaveBeenCalledWith("task-1", expect.any(Object), commitObservation);
	});

	it("does not persist hook metadata from an unexpected startup conversation", async () => {
		const applyHookMetadata = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					resumeSessionId: "expected-session",
				}),
			),
			applyHookMetadata,
			applyHookActivity: vi.fn(),
		});
		vi.mocked(manager.observeTaskSessionLaunchHook).mockReturnValue(false);
		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "activity",
			metadata: {
				source: "codex",
				hookEventName: "SessionStart",
				sessionInstanceId: "launch-1",
				sessionId: "wrong-session",
			},
			delivery: {
				id: "00000000-0000-4000-8000-000000000002",
				occurredAt: 100,
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.recordHookReceived).toHaveBeenCalledWith("task-1");
		expect(applyHookMetadata).not.toHaveBeenCalled();
		expect(manager.commitHookEventOrder).toHaveBeenCalledWith("task-1", expect.any(Object), false);
	});

	it("treats ineligible hook transitions as successful no-ops", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			applyHookActivity: vi.fn(),
		});

		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_in_progress",
		});

		expect(response).toEqual({ ok: true });
		expect(manager.applyHookTransition).not.toHaveBeenCalled();
		expect(manager.applyHookTransition).not.toHaveBeenCalled();
		expect(manager.commitHookEventOrder).toHaveBeenCalledWith("task-1", expect.any(Object), true);
	});

	it("reports an eligible transition that the state machine rejects", async () => {
		const summary = createSummary({ state: "running" });
		const manager = createMockManager({
			getSummary: vi.fn(() => summary),
			applyHookActivity: vi.fn(),
		});
		vi.mocked(manager.applyHookTransition).mockReturnValue({
			changed: false,
			patch: {},
			clearAttentionBuffer: false,
			summary,
		});
		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
		});

		expect(response).toEqual({ ok: false, error: 'Task "task-1" transition failed' });
		expect(manager.commitHookEventOrder).not.toHaveBeenCalled();
	});

	it("stores activity metadata without changing session state", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
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
		expect(manager.applyHookTransition).not.toHaveBeenCalled();
		expect(manager.applyHookTransition).not.toHaveBeenCalled();
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

	it("keeps Codex Stop without completion metadata as a review transition", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
			toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			applyHookMetadata: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});
		const captureTaskTurnCheckpoint = vi.fn(async () => ({
			turn: 1,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
			commit: "aaa",
			createdAt: Date.now(),
		}));

		const api = createTestApi(manager, {
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef: vi.fn(async () => undefined),
		});

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
			metadata: {
				source: "codex",
				hookEventName: "Stop",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.applyHookTransition).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ type: "hook.to_review", reason: "hook" }),
		);
		expect(manager.applyHookTransition).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				type: "hook.to_review",
				metadata: expect.objectContaining({ hookEventName: "Stop", source: "codex" }),
			}),
		);
		expect(mockStore(manager).applyHookMetadata).not.toHaveBeenCalled();
	});

	it("keeps Codex Stop with final metadata as a review transition", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
			toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			applyHookMetadata: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});
		const captureTaskTurnCheckpoint = vi.fn(async () => ({
			turn: 1,
			ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
			commit: "aaa",
			createdAt: Date.now(),
		}));

		const api = createTestApi(manager, {
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef: vi.fn(async () => undefined),
		});

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
			metadata: {
				source: "codex",
				hookEventName: "Stop",
				finalMessage: "Done",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.applyHookTransition).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ type: "hook.to_review", reason: "hook" }),
		);
		expect(manager.applyHookTransition).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				type: "hook.to_review",
				metadata: expect.objectContaining({ hookEventName: "Stop", finalMessage: "Done", source: "codex" }),
			}),
		);
		expect(mockStore(manager).applyHookMetadata).not.toHaveBeenCalled();
	});

	it("emits the structured review follow-up broadcasts on to_review transitions", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
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

	it("maps Claude StopFailure hooks to error review without review-ready broadcast", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
			toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "error" })),
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
			metadata: {
				source: "claude",
				hookEventName: "StopFailure",
				activityText: "Claude turn failed: rate_limit",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.applyHookTransition).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ type: "hook.to_review", reason: "error" }),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(broadcaster.broadcastRuntimeProjectStateUpdated).toHaveBeenCalledWith("project-1", "/tmp/repo");
		expect(broadcaster.broadcastTaskReadyForReview).not.toHaveBeenCalled();
	});

	it("maps Claude agent-needs-input notifications to attention review", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
			toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "attention" })),
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
			metadata: {
				source: "claude",
				hookEventName: "Notification",
				notificationType: "agent_needs_input",
				activityText: "Needs input",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.applyHookTransition).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ type: "hook.to_review", reason: "attention" }),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(broadcaster.broadcastRuntimeProjectStateUpdated).toHaveBeenCalledWith("project-1", "/tmp/repo");
		expect(broadcaster.broadcastTaskReadyForReview).not.toHaveBeenCalled();
	});

	it.each([
		["AskUserQuestion", { source: "claude", hookEventName: "PreToolUse", toolName: "AskUserQuestion" }],
		["ExitPlanMode", { source: "claude", hookEventName: "PreToolUse", toolName: "ExitPlanMode" }],
		["MCP elicitation", { source: "claude", hookEventName: "Elicitation" }],
		[
			"elicitation notification",
			{ source: "claude", hookEventName: "Notification", notificationType: "elicitation_dialog" },
		],
	] as const)("maps Claude %s waits to attention review", async (_label, metadata) => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
			toReviewSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "attention" })),
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
			metadata,
		});

		expect(response).toEqual({ ok: true });
		expect(manager.applyHookTransition).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ type: "hook.to_review", reason: "attention" }),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(broadcaster.broadcastTaskReadyForReview).not.toHaveBeenCalled();
	});

	it("returns an MCP elicitation wait to running after ElicitationResult", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					agentId: "claude",
					latestHookActivity: {
						source: "claude",
						hookEventName: "Elicitation",
						notificationType: null,
						activityText: "Needs input",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						conversationSummaryText: null,
					},
				}),
			),
			toRunningSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});
		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "ElicitationResult" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.applyHookTransition).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ type: "hook.to_in_progress" }),
		);
	});

	it.each([
		["matching", "PreToolUse", "AskUserQuestion", "AskUserQuestion", true],
		["unrelated", "PreToolUse", "AskUserQuestion", "Bash", false],
		["matching plan-permission", "PermissionRequest", "ExitPlanMode", "ExitPlanMode", true],
	] as const)(
		"handles %s PostToolUse while Claude is asking a question",
		async (_label, currentHookEvent, currentToolName, incomingToolName, shouldResolve) => {
			const manager = createMockManager({
				getSummary: vi.fn(() =>
					createSummary({
						state: "awaiting_review",
						reviewReason: "attention",
						agentId: "claude",
						latestHookActivity: {
							source: "claude",
							hookEventName: currentHookEvent,
							notificationType: null,
							activityText: currentHookEvent === "PermissionRequest" ? "Waiting for approval" : "Needs input",
							toolName: currentToolName,
							toolInputSummary: currentToolName,
							finalMessage: null,
							conversationSummaryText: null,
						},
					}),
				),
				toRunningSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
				applyHookActivity: vi.fn(),
				appendConversationSummary: vi.fn(),
				setDisplaySummary: vi.fn(),
			});
			const api = createTestApi(manager);

			const response = await api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_in_progress",
				metadata: { source: "claude", hookEventName: "PostToolUse", toolName: incomingToolName },
			});

			expect(response).toEqual({ ok: true });
			if (shouldResolve) {
				expect(manager.applyHookTransition).toHaveBeenCalledWith(
					"task-1",
					expect.objectContaining({ type: "hook.to_in_progress" }),
				);
			} else {
				expect(manager.applyHookTransition).not.toHaveBeenCalled();
			}
		},
	);

	it("allows Claude UserPromptSubmit to resolve a background-agent input wait", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					agentId: "claude",
					latestHookActivity: {
						source: "claude",
						hookEventName: "Notification",
						notificationType: "agent_needs_input",
						activityText: "Needs input",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						conversationSummaryText: null,
					},
				}),
			),
			toRunningSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});
		const api = createTestApi(manager);

		await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
		});

		expect(manager.applyHookTransition).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ type: "hook.to_in_progress" }),
		);
	});

	it("preserves an attention wait when a pending-background Stop arrives as activity", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					agentId: "claude",
					latestHookActivity: {
						source: "claude",
						hookEventName: "Notification",
						notificationType: "agent_needs_input",
						activityText: "Needs input",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						conversationSummaryText: null,
					},
				}),
			),
			applyHookActivity: vi.fn(),
			appendConversationSummary: vi.fn(),
			setDisplaySummary: vi.fn(),
		});
		const api = createTestApi(manager);

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "activity",
			metadata: {
				source: "claude",
				hookEventName: "Stop",
				activityText: "Waiting for background work",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.applyHookTransition).not.toHaveBeenCalled();
		expect(manager.applyHookTransition).not.toHaveBeenCalled();
		expect(mockStore(manager).applyHookActivity).not.toHaveBeenCalled();
	});
});
