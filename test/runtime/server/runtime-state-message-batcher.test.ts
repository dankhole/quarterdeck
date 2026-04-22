import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogEntry, RuntimeTaskSessionSummary } from "../../../src/core";
import { RuntimeStateMessageBatcher } from "../../../src/server/runtime-state-message-batcher";
import type { TerminalSessionManager } from "../../../src/terminal";

function createSummary(taskId: string, updatedAt: number): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		sessionLaunchPath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt,
		lastOutputAt: updatedAt,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	};
}

function createLogEntry(id: string): LogEntry {
	return {
		id,
		timestamp: Number(id),
		level: "info",
		tag: "test",
		message: `entry-${id}`,
		source: "server",
	};
}

describe("RuntimeStateMessageBatcher", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("coalesces task summaries per project before flushing notifications", async () => {
		let onSummary: ((summary: RuntimeTaskSessionSummary) => void) | null = null;
		const onTaskSessionBatch = vi.fn();
		const onTaskNotificationBatch = vi.fn();
		const onProjectsRefreshRequested = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasClients: () => true,
			onTaskSessionBatch,
			onTaskNotificationBatch,
			onProjectsRefreshRequested,
			onDebugLogBatch: vi.fn(),
		});

		batcher.trackTerminalManager("project-1", {
			store: {
				onChange: (listener: (summary: RuntimeTaskSessionSummary) => void) => {
					onSummary = listener;
					return vi.fn();
				},
			},
		} as unknown as TerminalSessionManager);

		if (!onSummary) {
			throw new Error("Expected onChange listener to be registered.");
		}
		const emitSummary = onSummary as (summary: RuntimeTaskSessionSummary) => void;

		emitSummary(createSummary("task-1", 1));
		emitSummary(createSummary("task-1", 2));
		emitSummary(createSummary("task-2", 3));

		await vi.advanceTimersByTimeAsync(150);

		expect(onTaskSessionBatch).toHaveBeenCalledOnce();
		expect(onTaskSessionBatch).toHaveBeenCalledWith("project-1", [
			createSummary("task-1", 2),
			createSummary("task-2", 3),
		]);
		expect(onTaskNotificationBatch).toHaveBeenCalledWith("project-1", [
			createSummary("task-1", 2),
			createSummary("task-2", 3),
		]);
		expect(onProjectsRefreshRequested).toHaveBeenCalledWith("project-1");
	});

	it("batches debug log entries only while clients are connected", async () => {
		let hasClients = false;
		const onDebugLogBatch = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasClients: () => hasClients,
			onTaskSessionBatch: vi.fn(),
			onTaskNotificationBatch: vi.fn(),
			onProjectsRefreshRequested: vi.fn(),
			onDebugLogBatch,
		});

		batcher.queueDebugLogEntry(createLogEntry("1"));
		await vi.advanceTimersByTimeAsync(150);
		expect(onDebugLogBatch).not.toHaveBeenCalled();

		hasClients = true;
		batcher.queueDebugLogEntry(createLogEntry("2"));
		batcher.queueDebugLogEntry(createLogEntry("3"));
		await vi.advanceTimersByTimeAsync(150);

		expect(onDebugLogBatch).toHaveBeenCalledOnce();
		expect(onDebugLogBatch).toHaveBeenCalledWith([createLogEntry("2"), createLogEntry("3")]);
	});

	it("drops queued task-session updates when a project is disposed before flush", async () => {
		let onSummary: ((summary: RuntimeTaskSessionSummary) => void) | null = null;
		const onTaskSessionBatch = vi.fn();
		const onTaskNotificationBatch = vi.fn();
		const onProjectsRefreshRequested = vi.fn();
		const unsubscribe = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasClients: () => true,
			onTaskSessionBatch,
			onTaskNotificationBatch,
			onProjectsRefreshRequested,
			onDebugLogBatch: vi.fn(),
		});

		batcher.trackTerminalManager("project-1", {
			store: {
				onChange: (listener: (summary: RuntimeTaskSessionSummary) => void) => {
					onSummary = listener;
					return unsubscribe;
				},
			},
		} as unknown as TerminalSessionManager);

		if (!onSummary) {
			throw new Error("Expected onChange listener to be registered.");
		}
		(onSummary as (summary: RuntimeTaskSessionSummary) => void)(createSummary("task-1", 1));

		batcher.disposeProject("project-1");
		await vi.advanceTimersByTimeAsync(150);

		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(onTaskSessionBatch).not.toHaveBeenCalled();
		expect(onTaskNotificationBatch).not.toHaveBeenCalled();
		expect(onProjectsRefreshRequested).not.toHaveBeenCalled();
	});
});
