import { describe, expect, it, vi } from "vitest";

import { createMockManager, createSummary, createTestApi, permissionActivity } from "./_helpers";

function flushMicrotasks(): Promise<void> {
	return Promise.resolve().then(() => undefined);
}

describe("createHooksApi — Claude transcript enrichment", () => {
	it("returns from to_review ingest before reading the Claude transcript", async () => {
		const scheduledTasks: Array<() => void> = [];
		const appendConversationSummary = vi.fn();
		const applyHookMetadata = vi.fn();
		let summary = createSummary({ state: "running" });
		const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const manager = createMockManager({
			getSummary: vi.fn(() => summary),
			transitionToReview: vi.fn(() => {
				summary = transitionedSummary;
				return transitionedSummary;
			}),
			transitionToRunning: vi.fn(),
			applyHookMetadata,
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		});
		const extractClaudeTranscriptSummary = vi.fn(async () => "Finished the hook reliability fix");
		const api = createTestApi(manager, {
			extractClaudeTranscriptSummary,
			scheduleHookBackgroundTask: vi.fn((task) => {
				scheduledTasks.push(task);
			}),
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/quarterdeck/test",
				commit: "abc123",
				createdAt: Date.now(),
			})),
		});

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
			metadata: {
				source: "claude",
				hookEventName: "Stop",
				transcriptPath: "/tmp/claude-transcript.jsonl",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(extractClaudeTranscriptSummary).not.toHaveBeenCalled();
		expect(appendConversationSummary).not.toHaveBeenCalled();
		expect(scheduledTasks).toHaveLength(1);

		scheduledTasks[0]?.();
		await flushMicrotasks();

		expect(extractClaudeTranscriptSummary).toHaveBeenCalledWith("/tmp/claude-transcript.jsonl");
		expect(applyHookMetadata).toHaveBeenLastCalledWith(
			"task-1",
			expect.objectContaining({
				conversationSummaryText: "Finished the hook reliability fix",
				finalMessage: "Finished the hook reliability fix",
				activityText: "Final: Finished the hook reliability fix",
			}),
		);
		expect(appendConversationSummary).toHaveBeenCalledWith("task-1", {
			text: "Finished the hook reliability fix",
			capturedAt: expect.any(Number),
		});
	});

	it("keeps the transition successful when transcript enrichment finds no summary", async () => {
		const scheduledTasks: Array<() => void> = [];
		const appendConversationSummary = vi.fn();
		const applyHookMetadata = vi.fn();
		let summary = createSummary({ state: "running" });
		const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const manager = createMockManager({
			getSummary: vi.fn(() => summary),
			transitionToReview: vi.fn(() => {
				summary = transitionedSummary;
				return transitionedSummary;
			}),
			transitionToRunning: vi.fn(),
			applyHookMetadata,
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		});
		const api = createTestApi(manager, {
			extractClaudeTranscriptSummary: vi.fn(async () => null),
			scheduleHookBackgroundTask: vi.fn((task) => {
				scheduledTasks.push(task);
			}),
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/quarterdeck/test",
				commit: "abc123",
				createdAt: Date.now(),
			})),
		});

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
			metadata: {
				source: "claude",
				hookEventName: "Stop",
				transcriptPath: "/tmp/empty-transcript.jsonl",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(applyHookMetadata).toHaveBeenCalledTimes(1);

		scheduledTasks[0]?.();
		await flushMicrotasks();

		expect(applyHookMetadata).toHaveBeenCalledTimes(1);
		expect(appendConversationSummary).not.toHaveBeenCalled();
	});

	it("does not overwrite permission activity when enriching a blocked Stop hook", async () => {
		const scheduledTasks: Array<() => void> = [];
		const appendConversationSummary = vi.fn();
		const applyHookMetadata = vi.fn();
		const manager = createMockManager({
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: permissionActivity(),
				}),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookMetadata,
			applyHookActivity: vi.fn(),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		});
		const api = createTestApi(manager, {
			extractClaudeTranscriptSummary: vi.fn(async () => "Implemented the requested change"),
			scheduleHookBackgroundTask: vi.fn((task) => {
				scheduledTasks.push(task);
			}),
		});

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
			metadata: {
				source: "claude",
				hookEventName: "Stop",
				transcriptPath: "/tmp/blocked-stop.jsonl",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(applyHookMetadata).not.toHaveBeenCalled();
		expect(scheduledTasks).toHaveLength(1);

		scheduledTasks[0]?.();
		await flushMicrotasks();

		expect(applyHookMetadata).not.toHaveBeenCalled();
		expect(appendConversationSummary).toHaveBeenCalledWith("task-1", {
			text: "Implemented the requested change",
			capturedAt: expect.any(Number),
		});
	});

	it("skips stale enrichment when newer hook activity arrives before transcript parsing finishes", async () => {
		const scheduledTasks: Array<() => void> = [];
		const appendConversationSummary = vi.fn();
		const applyHookMetadata = vi.fn();
		let summary = createSummary({ state: "running", lastHookAt: null });
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			lastHookAt: 100,
		});
		const newerHookSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			lastHookAt: 200,
			latestHookActivity: {
				hookEventName: "Stop",
				notificationType: null,
				activityText: "Final: newer result",
				toolName: null,
				toolInputSummary: null,
				finalMessage: "newer result",
				source: "claude",
				conversationSummaryText: null,
			},
		});
		const manager = createMockManager({
			getSummary: vi.fn(() => summary),
			transitionToReview: vi.fn(() => {
				summary = transitionedSummary;
				return transitionedSummary;
			}),
			transitionToRunning: vi.fn(),
			applyHookMetadata,
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
			appendConversationSummary,
			setDisplaySummary: vi.fn(),
		});
		const api = createTestApi(manager, {
			extractClaudeTranscriptSummary: vi.fn(async () => "stale result"),
			scheduleHookBackgroundTask: vi.fn((task) => {
				scheduledTasks.push(task);
			}),
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/quarterdeck/test",
				commit: "abc123",
				createdAt: Date.now(),
			})),
		});

		const response = await api.ingest({
			taskId: "task-1",
			projectId: "project-1",
			event: "to_review",
			metadata: {
				source: "claude",
				hookEventName: "Stop",
				transcriptPath: "/tmp/stale-transcript.jsonl",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(applyHookMetadata).toHaveBeenCalledTimes(1);
		expect(scheduledTasks).toHaveLength(1);

		summary = newerHookSummary;
		scheduledTasks[0]?.();
		await flushMicrotasks();

		expect(applyHookMetadata).toHaveBeenCalledTimes(1);
		expect(appendConversationSummary).not.toHaveBeenCalled();
	});
});
