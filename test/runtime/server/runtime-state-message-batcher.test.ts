import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticRecordEnvelope, RuntimeTaskSessionSummary } from "../../../src/core";
import { RuntimeStateMessageBatcher } from "../../../src/server/runtime-state-message-batcher";
import type { TerminalSessionManager } from "../../../src/terminal";
import {
	createTestTaskNativeWorkEvidence,
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

function createSummary(taskId: string, updatedAt: number): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		state: "running",
		agentId: "codex",
		sessionInstanceId: "process-1",
		sessionLaunchPath: "/tmp/worktree",
		pid: 1234,
		nativeWorkEvidence: createTestTaskNativeWorkEvidence(),
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
			onTasksReadyForReview: vi.fn(),
			onProjectsRefreshRequested,
			onDiagnosticRecordBatch: vi.fn(),
		});

		const terminal = createTerminalManagerStub();
		batcher.trackTerminalManager("project-1", terminal.manager);

		const firstTask = createSummary("task-1", 1);
		const latestTask = createSummary("task-1", 2);
		const secondTask = createSummary("task-2", 3);
		terminal.emitSummary(firstTask);
		terminal.emitSummary(latestTask);
		terminal.emitSummary(secondTask);

		await vi.advanceTimersByTimeAsync(150);

		expect(onTaskSessionBatch).toHaveBeenCalledOnce();
		expect(onTaskSessionBatch).toHaveBeenCalledWith("project-1", [latestTask, secondTask]);
		expect(onTaskNotificationBatch).toHaveBeenCalledWith("project-1", [latestTask, secondTask]);
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
			onTasksReadyForReview: vi.fn(),
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

	it("updates notifications and pills when a durable interaction changes the semantic indicator", async () => {
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
		const onTasksReadyForReview = vi.fn();
		const onProjectsRefreshRequested = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasDiagnosticSubscribers: () => true,
			onTaskSessionBatch: vi.fn(),
			onTaskNotificationBatch,
			onTasksReadyForReview,
			onProjectsRefreshRequested,
			onDiagnosticRecordBatch: vi.fn(),
		});
		const terminal = createTerminalManagerStub([initial]);
		batcher.trackTerminalManager("project-1", terminal.manager);

		const permissionUpdate = createTestTaskSessionSummary({
			...initial,
			updatedAt: 2,
			outstandingInteraction: createTestTaskOutstandingInteraction({
				provider: "codex",
				kind: "permission",
				requestEventName: "PermissionRequest",
			}),
			latestHookActivity: {
				activityText: "Waiting for approval",
				hookEventName: "PermissionRequest",
			},
		});
		terminal.emitSummary(permissionUpdate);

		await vi.advanceTimersByTimeAsync(150);

		expect(onTaskNotificationBatch).toHaveBeenCalledWith("project-1", [permissionUpdate]);
		expect(onTasksReadyForReview).not.toHaveBeenCalled();
		expect(onProjectsRefreshRequested).toHaveBeenCalledWith("project-1");
	});

	it("refreshes project counts when a session crosses the awaiting-review boundary", async () => {
		const initial = createSummary("task-1", 1);
		const onTaskNotificationBatch = vi.fn();
		const onTasksReadyForReview = vi.fn();
		const onProjectsRefreshRequested = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasDiagnosticSubscribers: () => true,
			onTaskSessionBatch: vi.fn(),
			onTaskNotificationBatch,
			onTasksReadyForReview,
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
		expect(onTasksReadyForReview).toHaveBeenCalledWith("project-1", ["task-1"]);
		expect(onProjectsRefreshRequested).toHaveBeenCalledWith("project-1");
	});

	it("does not emit a stale review-ready event when the task resumes within the same batch", async () => {
		const initial = createSummary("task-1", 1);
		const onTaskSessionBatch = vi.fn();
		const onTasksReadyForReview = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasDiagnosticSubscribers: () => true,
			onTaskSessionBatch,
			onTaskNotificationBatch: vi.fn(),
			onTasksReadyForReview,
			onProjectsRefreshRequested: vi.fn(),
			onDiagnosticRecordBatch: vi.fn(),
		});
		const terminal = createTerminalManagerStub([initial]);
		batcher.trackTerminalManager("project-1", terminal.manager);

		terminal.emitSummary(
			createTestTaskSessionSummary({
				...initial,
				state: "awaiting_review",
				reviewReason: "hook",
				updatedAt: 2,
			}),
		);
		const resumed = createTestTaskSessionSummary({
			...initial,
			updatedAt: 3,
		});
		terminal.emitSummary(resumed);

		await vi.advanceTimersByTimeAsync(150);

		expect(onTaskSessionBatch).toHaveBeenCalledWith("project-1", [resumed]);
		expect(onTasksReadyForReview).not.toHaveBeenCalled();
	});

	it.each(["error", "interrupted"] as const)(
		"refreshes project counts when a running session becomes Review/%s",
		async (reviewReason) => {
			const initial = createSummary("task-1", 1);
			const onProjectsRefreshRequested = vi.fn();
			const batcher = new RuntimeStateMessageBatcher({
				hasDiagnosticSubscribers: () => true,
				onTaskSessionBatch: vi.fn(),
				onTaskNotificationBatch: vi.fn(),
				onTasksReadyForReview: vi.fn(),
				onProjectsRefreshRequested,
				onDiagnosticRecordBatch: vi.fn(),
			});
			const terminal = createTerminalManagerStub([initial]);
			batcher.trackTerminalManager("project-1", terminal.manager);

			terminal.emitSummary(
				createTestTaskSessionSummary({
					...initial,
					state: "awaiting_review",
					reviewReason,
					nativeWorkEvidence: null,
					updatedAt: 2,
				}),
			);
			await vi.advanceTimersByTimeAsync(150);

			expect(onProjectsRefreshRequested).toHaveBeenCalledWith("project-1");
		},
	);

	it("batches canonical diagnostic records only while clients are connected", async () => {
		let hasClients = false;
		const onDiagnosticRecordBatch = vi.fn();
		const batcher = new RuntimeStateMessageBatcher({
			hasDiagnosticSubscribers: () => hasClients,
			onTaskSessionBatch: vi.fn(),
			onTaskNotificationBatch: vi.fn(),
			onTasksReadyForReview: vi.fn(),
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
			onTasksReadyForReview: vi.fn(),
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
			onTasksReadyForReview: vi.fn(),
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
