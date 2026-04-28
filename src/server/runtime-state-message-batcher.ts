import type { LogEntry, RuntimeTaskSessionSummary } from "../core";
import type { TerminalSessionManager } from "../terminal";

const TASK_SESSION_STREAM_BATCH_MS = 150;
const DEBUG_LOG_BATCH_MS = 150;

// [perf-investigation] Measure how often session-summary changes become
// runtime-state stream batches, notification batches, and project refreshes.
// Uses direct console output to avoid feeding Quarterdeck's runtime log stream.
// Remove when done.
const FANOUT_REPORT_INTERVAL_MS = 5000;
interface FanoutPerfWindow {
	onChangeEvents: number;
	queueCalls: number;
	flushes: number;
	flushedSummaries: number;
	deliveries: number;
	deliveredSummaries: number;
	notificationBatches: number;
	projectRefreshRequests: number;
	maxPendingSummaries: number;
	timerSchedules: number;
	lastProjectId: string;
	lastTaskId: string;
	startedAt: number;
}

const fanoutPerfWindow: FanoutPerfWindow = {
	onChangeEvents: 0,
	queueCalls: 0,
	flushes: 0,
	flushedSummaries: 0,
	deliveries: 0,
	deliveredSummaries: 0,
	notificationBatches: 0,
	projectRefreshRequests: 0,
	maxPendingSummaries: 0,
	timerSchedules: 0,
	lastProjectId: "",
	lastTaskId: "",
	startedAt: Date.now(),
};

function roundPerf(value: number): number {
	return Math.round(value * 100) / 100;
}

function maybeReportFanoutPerf(projectId: string): void {
	const now = Date.now();
	const elapsed = now - fanoutPerfWindow.startedAt;
	if (elapsed < FANOUT_REPORT_INTERVAL_MS) {
		return;
	}
	console.warn("[perf-investigation] session summary fanout rate", {
		windowMs: elapsed,
		onChangeEvents: fanoutPerfWindow.onChangeEvents,
		onChangePerSec: roundPerf((fanoutPerfWindow.onChangeEvents / elapsed) * 1000),
		queueCalls: fanoutPerfWindow.queueCalls,
		flushes: fanoutPerfWindow.flushes,
		flushedSummaries: fanoutPerfWindow.flushedSummaries,
		deliveries: fanoutPerfWindow.deliveries,
		deliveredSummaries: fanoutPerfWindow.deliveredSummaries,
		notificationBatches: fanoutPerfWindow.notificationBatches,
		projectRefreshRequests: fanoutPerfWindow.projectRefreshRequests,
		maxPendingSummaries: fanoutPerfWindow.maxPendingSummaries,
		timerSchedules: fanoutPerfWindow.timerSchedules,
		lastProjectId: projectId,
		lastTaskId: fanoutPerfWindow.lastTaskId,
	});
	fanoutPerfWindow.onChangeEvents = 0;
	fanoutPerfWindow.queueCalls = 0;
	fanoutPerfWindow.flushes = 0;
	fanoutPerfWindow.flushedSummaries = 0;
	fanoutPerfWindow.deliveries = 0;
	fanoutPerfWindow.deliveredSummaries = 0;
	fanoutPerfWindow.notificationBatches = 0;
	fanoutPerfWindow.projectRefreshRequests = 0;
	fanoutPerfWindow.maxPendingSummaries = 0;
	fanoutPerfWindow.timerSchedules = 0;
	fanoutPerfWindow.lastProjectId = projectId;
	fanoutPerfWindow.lastTaskId = "";
	fanoutPerfWindow.startedAt = now;
}

function reportSessionSummaryChange(projectId: string, summary: RuntimeTaskSessionSummary): void {
	fanoutPerfWindow.onChangeEvents += 1;
	fanoutPerfWindow.lastProjectId = projectId;
	fanoutPerfWindow.lastTaskId = summary.taskId;
}

function reportSessionSummaryQueued(projectId: string, summary: RuntimeTaskSessionSummary, pendingSize: number): void {
	fanoutPerfWindow.queueCalls += 1;
	fanoutPerfWindow.maxPendingSummaries = Math.max(fanoutPerfWindow.maxPendingSummaries, pendingSize);
	fanoutPerfWindow.lastProjectId = projectId;
	fanoutPerfWindow.lastTaskId = summary.taskId;
}

function reportSessionSummaryTimerScheduled(projectId: string): void {
	fanoutPerfWindow.timerSchedules += 1;
	fanoutPerfWindow.lastProjectId = projectId;
}

function reportSessionSummaryFlush(projectId: string, summaryCount: number): void {
	fanoutPerfWindow.flushes += 1;
	fanoutPerfWindow.flushedSummaries += summaryCount;
	fanoutPerfWindow.lastProjectId = projectId;
}

function reportSessionSummaryDelivery(projectId: string, summaryCount: number): void {
	fanoutPerfWindow.deliveries += 1;
	fanoutPerfWindow.deliveredSummaries += summaryCount;
	fanoutPerfWindow.notificationBatches += 1;
	fanoutPerfWindow.projectRefreshRequests += 1;
	fanoutPerfWindow.lastProjectId = projectId;
	maybeReportFanoutPerf(projectId);
}

interface RuntimeTaskSessionEvent {
	projectId: string;
	summaries: RuntimeTaskSessionSummary[];
}

interface CreateRuntimeStateTaskSessionEventDeliveryDependencies {
	onTaskSessionBatch: (projectId: string, summaries: RuntimeTaskSessionSummary[]) => void;
	onTaskNotificationBatch: (projectId: string, summaries: RuntimeTaskSessionSummary[]) => void;
	onProjectsRefreshRequested: (preferredCurrentProjectId: string | null) => void;
}

class RuntimeStateTaskSessionEventDelivery {
	constructor(private readonly deps: CreateRuntimeStateTaskSessionEventDeliveryDependencies) {}

	deliver(event: RuntimeTaskSessionEvent): void {
		// These three outputs intentionally share one delivery moment: the active
		// project session delta, cross-project notification memory, and project
		// summary refresh should continue to observe the same coalesced event.
		reportSessionSummaryDelivery(event.projectId, event.summaries.length);
		this.deps.onTaskSessionBatch(event.projectId, event.summaries);
		this.deps.onTaskNotificationBatch(event.projectId, event.summaries);
		this.deps.onProjectsRefreshRequested(event.projectId);
	}
}

interface CreateRuntimeTaskSessionBatchQueueDependencies {
	onTaskSessionEventReady: (event: RuntimeTaskSessionEvent) => void;
}

class RuntimeTaskSessionBatchQueue {
	private readonly pendingSummaries = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	private readonly flushTimers = new Map<string, NodeJS.Timeout>();

	constructor(private readonly deps: CreateRuntimeTaskSessionBatchQueueDependencies) {}

	queue(projectId: string, summary: RuntimeTaskSessionSummary): void {
		let pending = this.pendingSummaries.get(projectId);
		if (!pending) {
			pending = new Map<string, RuntimeTaskSessionSummary>();
			this.pendingSummaries.set(projectId, pending);
		}
		pending.set(summary.taskId, summary);
		reportSessionSummaryQueued(projectId, summary, pending.size);
		if (this.flushTimers.has(projectId)) {
			return;
		}
		reportSessionSummaryTimerScheduled(projectId);
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
		this.pendingSummaries.delete(projectId);
	}

	close(): void {
		for (const timer of this.flushTimers.values()) {
			clearTimeout(timer);
		}
		this.flushTimers.clear();
		this.pendingSummaries.clear();
	}

	private flush(projectId: string): void {
		const pending = this.pendingSummaries.get(projectId);
		if (!pending || pending.size === 0) {
			return;
		}
		this.pendingSummaries.delete(projectId);
		reportSessionSummaryFlush(projectId, pending.size);
		this.deps.onTaskSessionEventReady({
			projectId,
			summaries: Array.from(pending.values()),
		});
	}
}

interface CreateRuntimeDebugLogBatchQueueDependencies {
	hasClients: () => boolean;
	onDebugLogBatch: (entries: LogEntry[]) => void;
}

class RuntimeDebugLogBatchQueue {
	private readonly pendingEntries: LogEntry[] = [];
	private flushTimer: NodeJS.Timeout | null = null;

	constructor(private readonly deps: CreateRuntimeDebugLogBatchQueueDependencies) {}

	queue(entry: LogEntry): void {
		if (!this.deps.hasClients()) {
			return;
		}
		this.pendingEntries.push(entry);
		if (this.flushTimer !== null) {
			return;
		}
		this.flushTimer = setTimeout(() => this.flush(), DEBUG_LOG_BATCH_MS);
		this.flushTimer.unref();
	}

	close(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.pendingEntries.length = 0;
	}

	private flush(): void {
		this.flushTimer = null;
		if (this.pendingEntries.length === 0 || !this.deps.hasClients()) {
			// Debug log batching is a best-effort live stream only. Reconnecting
			// clients are reseeded from the runtime logger ring buffer via the
			// separate debug_logging_state snapshot path in RuntimeStateHub.
			this.pendingEntries.length = 0;
			return;
		}
		this.deps.onDebugLogBatch(this.pendingEntries.splice(0));
	}
}

export interface CreateRuntimeStateMessageBatcherDependencies
	extends CreateRuntimeStateTaskSessionEventDeliveryDependencies,
		CreateRuntimeDebugLogBatchQueueDependencies {}

export class RuntimeStateMessageBatcher {
	private readonly terminalSummaryUnsubscribes = new Map<string, () => void>();
	private readonly taskSessionEventDelivery: RuntimeStateTaskSessionEventDelivery;
	private readonly taskSessionBatchQueue: RuntimeTaskSessionBatchQueue;
	private readonly debugLogBatchQueue: RuntimeDebugLogBatchQueue;

	constructor(deps: CreateRuntimeStateMessageBatcherDependencies) {
		this.taskSessionEventDelivery = new RuntimeStateTaskSessionEventDelivery(deps);
		this.taskSessionBatchQueue = new RuntimeTaskSessionBatchQueue({
			onTaskSessionEventReady: (event) => {
				this.taskSessionEventDelivery.deliver(event);
			},
		});
		this.debugLogBatchQueue = new RuntimeDebugLogBatchQueue(deps);
	}

	trackTerminalManager(projectId: string, manager: TerminalSessionManager): void {
		if (this.terminalSummaryUnsubscribes.has(projectId)) {
			return;
		}
		const unsubscribe = manager.store.onChange((summary) => {
			reportSessionSummaryChange(projectId, summary);
			this.taskSessionBatchQueue.queue(projectId, summary);
			maybeReportFanoutPerf(projectId);
		});
		this.terminalSummaryUnsubscribes.set(projectId, unsubscribe);
	}

	queueDebugLogEntry(entry: LogEntry): void {
		this.debugLogBatchQueue.queue(entry);
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
		this.debugLogBatchQueue.close();
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
