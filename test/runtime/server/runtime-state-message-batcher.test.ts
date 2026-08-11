import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogEntry, RuntimeTaskSessionSummary } from "../../../src/core";
import { RuntimeStateMessageBatcher } from "../../../src/server/runtime-state-message-batcher";
import type { TerminalSessionManager } from "../../../src/terminal";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

function createSummary(taskId: string, updatedAt: number): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		state: "running",
		agentId: "codex",
		sessionLaunchPath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt,
		lastOutputAt: updatedAt,
	});
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

function createTerminalManagerStub(initialSummaries: RuntimeTaskSessionSummary[] = []): {
	manager: TerminalSessionManager;
	emitSummary: (summary: RuntimeTaskSessionSummary) => void;
	unsubscribe: ReturnType<typeof vi.fn>;
} {
	let listener: ((summary: RuntimeTaskSessionSummary) => void) | null = null;
	const unsubscribe = vi.fn();
	return {
		manager: {
			store: {
				listSummaries: () => initialSummaries,
				onChange: (nextListener: (summary: RuntimeTaskSessionSummary) => void) => {
					listener = nextListener;
					return unsubscribe;
				},
			},
		} as unknown as TerminalSessionManager,
		emitSummary: (summary) => {
			if (!listener) {
				throw new Error("Expected onChange listener to be registered.");
			}
			listener(summary);
		},
		unsubscribe,
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

		const terminal = createTerminalManagerStub();
		batcher.trackTerminalManager("project-1", terminal.manager);

		terminal.emitSummary(createSummary("task-1", 1));
		terminal.emitSummary(createSummary("task-1", 2));
		terminal.emitSummary(createSummary("task-2", 3));

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

	it("keeps activity-only updates on the active-project stream without rebuilding global projections", async () => {
		const initial = createSummary("task-1", 1);
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
		const terminal = createTerminalManagerStub([initial]);
		batcher.trackTerminalManager("project-1", terminal.manager);

		const activityUpdate = createTestTaskSessionSummary({
			...initial,
			updatedAt: 2,
			lastHookAt: 2,
			latestHookActivity: {
				activityText: "Reading src/server/runtime-state-hub.ts",
				hookEventName: "PreToolUse",
				toolName: "Read",
			},
		});
		terminal.emitSummary(activityUpdate);

		await vi.advanceTimersByTimeAsync(150);

		expect(onTaskSessionBatch).toHaveBeenCalledWith("project-1", [activityUpdate]);
		expect(onTaskNotificationBatch).not.toHaveBeenCalled();
		expect(onProjectsRefreshRequested).not.toHaveBeenCalled();
	});

	it("updates notification memory when hook activity changes the semantic indicator", async () => {
		const initial = createTestTaskSessionSummary({
			...createSummary("task-1", 1),
			state: "awaiting_review",
			reviewReason: "hook",
			latestHookActivity: {
				activityText: "Task complete",
				hookEventName: "Stop",
			},
		});
		const onTaskNotificationBatch = vi.fn();
		const onProjectsRefreshRequested = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasClients: () => true,
			onTaskSessionBatch: vi.fn(),
			onTaskNotificationBatch,
			onProjectsRefreshRequested,
			onDebugLogBatch: vi.fn(),
		});
		const terminal = createTerminalManagerStub([initial]);
		batcher.trackTerminalManager("project-1", terminal.manager);

		const permissionUpdate = createTestTaskSessionSummary({
			...initial,
			updatedAt: 2,
			latestHookActivity: {
				activityText: "Waiting for approval",
				hookEventName: "PermissionRequest",
			},
		});
		terminal.emitSummary(permissionUpdate);

		await vi.advanceTimersByTimeAsync(150);

		expect(onTaskNotificationBatch).toHaveBeenCalledWith("project-1", [permissionUpdate]);
		expect(onProjectsRefreshRequested).not.toHaveBeenCalled();
	});

	it("refreshes project counts when a session crosses the awaiting-review boundary", async () => {
		const initial = createSummary("task-1", 1);
		const onTaskNotificationBatch = vi.fn();
		const onProjectsRefreshRequested = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasClients: () => true,
			onTaskSessionBatch: vi.fn(),
			onTaskNotificationBatch,
			onProjectsRefreshRequested,
			onDebugLogBatch: vi.fn(),
		});
		const terminal = createTerminalManagerStub([initial]);
		batcher.trackTerminalManager("project-1", terminal.manager);

		const reviewUpdate = createTestTaskSessionSummary({
			...initial,
			state: "awaiting_review",
			reviewReason: "hook",
			updatedAt: 2,
		});
		terminal.emitSummary(reviewUpdate);

		await vi.advanceTimersByTimeAsync(150);

		expect(onTaskNotificationBatch).toHaveBeenCalledWith("project-1", [reviewUpdate]);
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

		const terminal = createTerminalManagerStub();
		batcher.trackTerminalManager("project-1", terminal.manager);
		terminal.emitSummary(createSummary("task-1", 1));

		batcher.disposeProject("project-1");
		await vi.advanceTimersByTimeAsync(150);

		expect(terminal.unsubscribe).toHaveBeenCalledOnce();
		expect(onTaskSessionBatch).not.toHaveBeenCalled();
		expect(onTaskNotificationBatch).not.toHaveBeenCalled();
		expect(onProjectsRefreshRequested).not.toHaveBeenCalled();
	});
});
