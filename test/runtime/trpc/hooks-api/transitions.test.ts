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

	it("keeps Codex Stop without completion metadata as a review transition", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
			transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			transitionToRunning: vi.fn(),
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
		expect(mockStore(manager).transitionToReview).toHaveBeenCalledWith("task-1", "hook");
		expect(mockStore(manager).applyHookMetadata).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ hookEventName: "Stop", source: "codex" }),
		);
	});

	it("keeps Codex Stop with final metadata as a review transition", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
			transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			transitionToRunning: vi.fn(),
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
		expect(mockStore(manager).transitionToReview).toHaveBeenCalledWith("task-1", "hook");
		expect(mockStore(manager).applyHookMetadata).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ hookEventName: "Stop", finalMessage: "Done", source: "codex" }),
		);
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

	it("maps Claude StopFailure hooks to error review without review-ready broadcast", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
			transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "error" })),
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
			metadata: {
				source: "claude",
				hookEventName: "StopFailure",
				activityText: "Claude turn failed: rate_limit",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).transitionToReview).toHaveBeenCalledWith("task-1", "error");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(broadcaster.broadcastRuntimeProjectStateUpdated).toHaveBeenCalledWith("project-1", "/tmp/repo");
		expect(broadcaster.broadcastTaskReadyForReview).not.toHaveBeenCalled();
	});

	it("maps Claude agent-needs-input notifications to attention review", async () => {
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
			transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "attention" })),
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
			metadata: {
				source: "claude",
				hookEventName: "Notification",
				notificationType: "agent_needs_input",
				activityText: "Needs input",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).transitionToReview).toHaveBeenCalledWith("task-1", "attention");
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
			transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "attention" })),
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
			metadata,
		});

		expect(response).toEqual({ ok: true });
		expect(mockStore(manager).transitionToReview).toHaveBeenCalledWith("task-1", "attention");
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
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
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
		expect(mockStore(manager).transitionToRunning).toHaveBeenCalledWith("task-1");
	});

	it.each([
		["matching", "PreToolUse", "AskUserQuestion", "AskUserQuestion", true],
		["unrelated", "PreToolUse", "AskUserQuestion", "Bash", false],
		["matching plan-permission", "PermissionRequest", "ExitPlanMode", "ExitPlanMode", true],
	] as const)("handles %s PostToolUse while Claude is asking a question", async (_label, currentHookEvent, currentToolName, incomingToolName, shouldResolve) => {
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
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
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
			expect(mockStore(manager).transitionToRunning).toHaveBeenCalledWith("task-1");
		} else {
			expect(mockStore(manager).transitionToRunning).not.toHaveBeenCalled();
		}
	});

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
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
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

		expect(mockStore(manager).transitionToRunning).toHaveBeenCalledWith("task-1");
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
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
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
		expect(mockStore(manager).transitionToReview).not.toHaveBeenCalled();
		expect(mockStore(manager).transitionToRunning).not.toHaveBeenCalled();
		expect(mockStore(manager).applyHookActivity).not.toHaveBeenCalled();
	});
});
