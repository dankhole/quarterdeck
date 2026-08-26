import {
	type DiagnosticCaptureScope,
	type DiagnosticRecordEnvelope,
	deriveTaskIndicatorState,
	didEnterTaskReviewReady,
	getRuntimeSessionWorkColumn,
	type RuntimeTaskSessionSummary,
} from "../core";
import type { TerminalSessionManager } from "../terminal";
import {
	isHighPriorityDiagnosticRecord,
	MAX_PENDING_DIAGNOSTIC_STREAM_RECORDS,
} from "./runtime-diagnostic-stream-policy";

const TASK_SESSION_STREAM_BATCH_MS = 150;
const DIAGNOSTIC_RECORD_BATCH_MS = 150;

interface RuntimeTaskSessionEvent {
	projectId: string;
	summaries: RuntimeTaskSessionSummary[];
	notificationSummaries: RuntimeTaskSessionSummary[];
	reviewReadyTaskIds: string[];
	refreshProjects: boolean;
}

interface RuntimeTaskSessionDeliveryClassification {
	broadcastNotification: boolean;
	notifyReadyForReview: boolean;
	refreshProjects: boolean;
}

interface PendingRuntimeTaskSessionUpdate extends RuntimeTaskSessionDeliveryClassification {
	summary: RuntimeTaskSessionSummary;
}

function classifyTaskSessionUpdate(
	previous: RuntimeTaskSessionSummary | null,
	next: RuntimeTaskSessionSummary,
): RuntimeTaskSessionDeliveryClassification {
	if (!previous) {
		// A newly observed session may affect both project counts and notification
		// memory. Prefer one conservative refresh over starting either projection
		// from an incomplete baseline.
		return {
			broadcastNotification: true,
			notifyReadyForReview: false,
			refreshProjects: true,
		};
	}

	const previousIndicator = deriveTaskIndicatorState(previous);
	const nextIndicator = deriveTaskIndicatorState(next);
	const broadcastNotification =
		previousIndicator.kind !== nextIndicator.kind ||
		previousIndicator.column !== nextIndicator.column ||
		previousIndicator.notification !== nextIndicator.notification ||
		previousIndicator.approvalRequired !== nextIndicator.approvalRequired ||
		previousIndicator.hookReview !== nextIndicator.hookReview;

	// Project pills consume the exclusive public classifier, not only board
	// columns. Review -> Needs Input stays in the Review column but must still
	// refresh `R n · NI n`; Running -> Review must also converge immediately.
	const refreshProjects =
		getRuntimeSessionWorkColumn(previous) !== getRuntimeSessionWorkColumn(next) ||
		previousIndicator.publicStatus !== nextIndicator.publicStatus;

	return {
		broadcastNotification,
		notifyReadyForReview: didEnterTaskReviewReady(previous, next),
		refreshProjects,
	};
}

interface CreateRuntimeStateTaskSessionEventDeliveryDependencies {
	onTaskSessionBatch: (projectId: string, summaries: RuntimeTaskSessionSummary[]) => void;
	onTaskNotificationBatch: (projectId: string, summaries: RuntimeTaskSessionSummary[]) => void;
	onTasksReadyForReview: (projectId: string, taskIds: readonly string[]) => void;
	onProjectsRefreshRequested: (preferredCurrentProjectId: string | null) => void;
}

class RuntimeStateTaskSessionEventDelivery {
	constructor(private readonly deps: CreateRuntimeStateTaskSessionEventDeliveryDependencies) {}

	deliver(event: RuntimeTaskSessionEvent): void {
		// The active project consumes the complete session delta, including useful
		// activity text. Cross-project notification memory and project-list counts
		// only consume changes that can affect their semantic projections.
		this.deps.onTaskSessionBatch(event.projectId, event.summaries);
		if (event.notificationSummaries.length > 0) {
			this.deps.onTaskNotificationBatch(event.projectId, event.notificationSummaries);
		}
		if (event.reviewReadyTaskIds.length > 0) {
			this.deps.onTasksReadyForReview(event.projectId, event.reviewReadyTaskIds);
		}
		if (event.refreshProjects) {
			this.deps.onProjectsRefreshRequested(event.projectId);
		}
	}
}

interface CreateRuntimeTaskSessionBatchQueueDependencies {
	onTaskSessionEventReady: (event: RuntimeTaskSessionEvent) => void;
}

class RuntimeTaskSessionBatchQueue {
	private readonly pendingUpdates = new Map<string, Map<string, PendingRuntimeTaskSessionUpdate>>();
	private readonly flushTimers = new Map<string, NodeJS.Timeout>();

	constructor(private readonly deps: CreateRuntimeTaskSessionBatchQueueDependencies) {}

	queue(
		projectId: string,
		summary: RuntimeTaskSessionSummary,
		classification: RuntimeTaskSessionDeliveryClassification,
	): void {
		let pending = this.pendingUpdates.get(projectId);
		if (!pending) {
			pending = new Map<string, PendingRuntimeTaskSessionUpdate>();
			this.pendingUpdates.set(projectId, pending);
		}
		const existing = pending.get(summary.taskId);
		pending.set(summary.taskId, {
			summary,
			broadcastNotification: classification.broadcastNotification || existing?.broadcastNotification === true,
			notifyReadyForReview: classification.notifyReadyForReview || existing?.notifyReadyForReview === true,
			refreshProjects: classification.refreshProjects || existing?.refreshProjects === true,
		});
		if (this.flushTimers.has(projectId)) {
			return;
		}
		const timer = setTimeout(() => {
			this.flushTimers.delete(projectId);
			this.flush(projectId);
		}, TASK_SESSION_STREAM_BATCH_MS);
		timer.unref();
		this.flushTimers.set(projectId, timer);
	}

	disposeProject(projectId: string): void {
		const timer = this.flushTimers.get(projectId);
		if (timer) {
			clearTimeout(timer);
		}
		this.flushTimers.delete(projectId);
		this.pendingUpdates.delete(projectId);
	}

	close(): void {
		for (const timer of this.flushTimers.values()) {
			clearTimeout(timer);
		}
		this.flushTimers.clear();
		this.pendingUpdates.clear();
	}

	getDiagnosticSnapshot(scope: Readonly<DiagnosticCaptureScope> = {}): {
		pendingProjects: number;
		pendingUpdates: number;
		oldestPendingAgeMs: null;
	} {
		const pending = Array.from(this.pendingUpdates.entries()).filter(
			([projectId, updates]) =>
				(!scope.projectId || projectId === scope.projectId) && (!scope.taskId || updates.has(scope.taskId)),
		);
		return {
			pendingProjects: pending.length,
			pendingUpdates: pending.reduce(
				(total, [, updates]) => total + (scope.taskId ? Number(updates.has(scope.taskId)) : updates.size),
				0,
			),
			oldestPendingAgeMs: null,
		};
	}

	private flush(projectId: string): void {
		const pending = this.pendingUpdates.get(projectId);
		if (!pending || pending.size === 0) {
			return;
		}
		this.pendingUpdates.delete(projectId);
		const updates = Array.from(pending.values());
		this.deps.onTaskSessionEventReady({
			projectId,
			summaries: updates.map((update) => update.summary),
			notificationSummaries: updates
				.filter((update) => update.broadcastNotification)
				.map((update) => update.summary),
			reviewReadyTaskIds: updates
				// Coalescing can observe Review and then Running within one batch.
				// Emit the edge only while the delivered summary still represents that
				// result, or the later Running snapshot would be followed by a stale
				// ready-for-review browser event.
				.filter((update) => update.notifyReadyForReview && deriveTaskIndicatorState(update.summary).reviewReady)
				.map((update) => update.summary.taskId),
			refreshProjects: updates.some((update) => update.refreshProjects),
		});
	}
}

interface CreateRuntimeDiagnosticRecordBatchQueueDependencies {
	hasDiagnosticSubscribers: () => boolean;
	onDiagnosticRecordBatch: (records: DiagnosticRecordEnvelope[]) => void;
}

class RuntimeDiagnosticRecordBatchQueue {
	private readonly pendingRecords: DiagnosticRecordEnvelope[] = [];
	private flushTimer: NodeJS.Timeout | null = null;
	private droppedRecords = 0;

	constructor(private readonly deps: CreateRuntimeDiagnosticRecordBatchQueueDependencies) {}

	queue(record: DiagnosticRecordEnvelope): void {
		if (!this.deps.hasDiagnosticSubscribers()) {
			return;
		}
		if (this.pendingRecords.length >= MAX_PENDING_DIAGNOSTIC_STREAM_RECORDS) {
			const replaceableIndex = isHighPriorityDiagnosticRecord(record)
				? this.pendingRecords.findIndex((candidate) => !isHighPriorityDiagnosticRecord(candidate))
				: -1;
			if (replaceableIndex < 0) {
				this.droppedRecords += 1;
				return;
			}
			this.pendingRecords.splice(replaceableIndex, 1);
			this.droppedRecords += 1;
		}
		this.pendingRecords.push(record);
		if (this.flushTimer !== null) {
			return;
		}
		this.flushTimer = setTimeout(() => this.flush(), DIAGNOSTIC_RECORD_BATCH_MS);
		this.flushTimer.unref();
	}

	close(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.pendingRecords.length = 0;
	}

	getDiagnosticSnapshot(): { pendingRecords: number; flushScheduled: boolean; droppedRecords: number } {
		return {
			pendingRecords: this.pendingRecords.length,
			flushScheduled: this.flushTimer !== null,
			droppedRecords: this.droppedRecords,
		};
	}

	private flush(): void {
		this.flushTimer = null;
		if (this.pendingRecords.length === 0 || !this.deps.hasDiagnosticSubscribers()) {
			// Live delivery is best effort. A later subscription explicitly
			// hydrates a bounded tail from the canonical recorder over HTTP.
			this.pendingRecords.length = 0;
			return;
		}
		this.deps.onDiagnosticRecordBatch(this.pendingRecords.splice(0));
	}
}

export interface CreateRuntimeStateMessageBatcherDependencies
	extends CreateRuntimeStateTaskSessionEventDeliveryDependencies,
		CreateRuntimeDiagnosticRecordBatchQueueDependencies {}

export interface RuntimeStateMessageBatcherDiagnosticSnapshot {
	trackedTerminalManagers: number;
	taskSessions: ReturnType<RuntimeTaskSessionBatchQueue["getDiagnosticSnapshot"]>;
	diagnosticRecords: ReturnType<RuntimeDiagnosticRecordBatchQueue["getDiagnosticSnapshot"]>;
}

export class RuntimeStateMessageBatcher {
	private readonly terminalSummaryUnsubscribes = new Map<string, () => void>();
	private readonly taskSessionEventDelivery: RuntimeStateTaskSessionEventDelivery;
	private readonly taskSessionBatchQueue: RuntimeTaskSessionBatchQueue;
	private readonly diagnosticRecordBatchQueue: RuntimeDiagnosticRecordBatchQueue;

	constructor(deps: CreateRuntimeStateMessageBatcherDependencies) {
		this.taskSessionEventDelivery = new RuntimeStateTaskSessionEventDelivery(deps);
		this.taskSessionBatchQueue = new RuntimeTaskSessionBatchQueue({
			onTaskSessionEventReady: (event) => {
				this.taskSessionEventDelivery.deliver(event);
			},
		});
		this.diagnosticRecordBatchQueue = new RuntimeDiagnosticRecordBatchQueue(deps);
	}

	trackTerminalManager(projectId: string, manager: TerminalSessionManager): void {
		if (this.terminalSummaryUnsubscribes.has(projectId)) {
			return;
		}
		const latestSummariesByTaskId = new Map(
			manager.store.listSummaries().map((summary) => [summary.taskId, summary]),
		);
		const unsubscribe = manager.store.onChange((summary) => {
			const previous = latestSummariesByTaskId.get(summary.taskId) ?? null;
			latestSummariesByTaskId.set(summary.taskId, summary);
			this.taskSessionBatchQueue.queue(projectId, summary, classifyTaskSessionUpdate(previous, summary));
		});
		this.terminalSummaryUnsubscribes.set(projectId, unsubscribe);
	}

	queueDiagnosticRecord(record: DiagnosticRecordEnvelope): void {
		this.diagnosticRecordBatchQueue.queue(record);
	}

	getDiagnosticSnapshot(scope: Readonly<DiagnosticCaptureScope> = {}): RuntimeStateMessageBatcherDiagnosticSnapshot {
		return {
			trackedTerminalManagers: scope.projectId
				? Number(this.terminalSummaryUnsubscribes.has(scope.projectId))
				: scope.taskId
					? 0
					: this.terminalSummaryUnsubscribes.size,
			taskSessions: this.taskSessionBatchQueue.getDiagnosticSnapshot(scope),
			diagnosticRecords: this.diagnosticRecordBatchQueue.getDiagnosticSnapshot(),
		};
	}

	disposeProject(projectId: string): void {
		const unsubscribe = this.terminalSummaryUnsubscribes.get(projectId);
		if (unsubscribe) {
			try {
				unsubscribe();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		this.terminalSummaryUnsubscribes.delete(projectId);
		this.taskSessionBatchQueue.disposeProject(projectId);
	}

	close(): void {
		this.diagnosticRecordBatchQueue.close();
		this.taskSessionBatchQueue.close();

		for (const unsubscribe of this.terminalSummaryUnsubscribes.values()) {
			try {
				unsubscribe();
			} catch {
				// Ignore listener cleanup errors during shutdown.
			}
		}
		this.terminalSummaryUnsubscribes.clear();
	}
}
