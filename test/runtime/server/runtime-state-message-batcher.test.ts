import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticRecordEnvelope, RuntimeTaskSessionSummary } from "../../../src/core";
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

function createDiagnosticRecord(id: string): DiagnosticRecordEnvelope {
	return {
		version: 1,
		id,
		sequence: Number(id),
		timestamp: Number(id),
		monotonicOffsetMs: Number(id),
		runtimeInstanceId: "runtime-test",
		source: "runtime",
		kind: "event",
		level: "info",
		name: `test.entry-${id}`,
		context: {},
		payload: {},
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
			hasDiagnosticSubscribers: () => true,
			onTaskSessionBatch,
			onTaskNotificationBatch,
			onProjectsRefreshRequested,
			onDiagnosticRecordBatch: vi.fn(),
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
			hasDiagnosticSubscribers: () => true,
			onTaskSessionBatch,
			onTaskNotificationBatch,
			onProjectsRefreshRequested,
			onDiagnosticRecordBatch: vi.fn(),
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
			hasDiagnosticSubscribers: () => true,
			onTaskSessionBatch: vi.fn(),
			onTaskNotificationBatch,
			onProjectsRefreshRequested,
			onDiagnosticRecordBatch: vi.fn(),
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
			hasDiagnosticSubscribers: () => true,
			onTaskSessionBatch: vi.fn(),
			onTaskNotificationBatch,
			onProjectsRefreshRequested,
			onDiagnosticRecordBatch: vi.fn(),
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

	it("batches canonical diagnostic records only while clients are connected", async () => {
		let hasClients = false;
		const onDiagnosticRecordBatch = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasDiagnosticSubscribers: () => hasClients,
			onTaskSessionBatch: vi.fn(),
			onTaskNotificationBatch: vi.fn(),
			onProjectsRefreshRequested: vi.fn(),
			onDiagnosticRecordBatch,
		});

		batcher.queueDiagnosticRecord(createDiagnosticRecord("1"));
		await vi.advanceTimersByTimeAsync(150);
		expect(onDiagnosticRecordBatch).not.toHaveBeenCalled();

		hasClients = true;
		batcher.queueDiagnosticRecord(createDiagnosticRecord("2"));
		batcher.queueDiagnosticRecord(createDiagnosticRecord("3"));
		await vi.advanceTimersByTimeAsync(150);

		expect(onDiagnosticRecordBatch).toHaveBeenCalledOnce();
		expect(onDiagnosticRecordBatch).toHaveBeenCalledWith([createDiagnosticRecord("2"), createDiagnosticRecord("3")]);
	});

	it("bounds live diagnostic delivery while preserving a warning over queued info", async () => {
		const onDiagnosticRecordBatch = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasDiagnosticSubscribers: () => true,
			onTaskSessionBatch: vi.fn(),
			onTaskNotificationBatch: vi.fn(),
			onProjectsRefreshRequested: vi.fn(),
			onDiagnosticRecordBatch,
		});

		for (let sequence = 1; sequence <= 65; sequence += 1) {
			batcher.queueDiagnosticRecord(createDiagnosticRecord(String(sequence)));
		}
		batcher.queueDiagnosticRecord({ ...createDiagnosticRecord("66"), level: "warn" });
		expect(batcher.getDiagnosticSnapshot().diagnosticRecords).toEqual({
			pendingRecords: 64,
			flushScheduled: true,
			droppedRecords: 2,
		});

		await vi.advanceTimersByTimeAsync(150);
		const delivered = onDiagnosticRecordBatch.mock.calls[0]?.[0] as DiagnosticRecordEnvelope[];
		expect(delivered).toHaveLength(64);
		expect(delivered.some((record) => record.sequence === 66 && record.level === "warn")).toBe(true);
		expect(delivered.some((record) => record.sequence === 1 || record.sequence === 65)).toBe(false);
	});

	it("drops queued task-session updates when a project is disposed before flush", async () => {
		const onTaskSessionBatch = vi.fn();
		const onTaskNotificationBatch = vi.fn();
		const onProjectsRefreshRequested = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasDiagnosticSubscribers: () => true,
			onTaskSessionBatch,
			onTaskNotificationBatch,
			onProjectsRefreshRequested,
			onDiagnosticRecordBatch: vi.fn(),
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
