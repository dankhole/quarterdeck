import type { LogEntry, RuntimeTaskSessionSummary } from "../core";
import type { TerminalSessionManager } from "../terminal";

const TASK_SESSION_STREAM_BATCH_MS = 150;
const DEBUG_LOG_BATCH_MS = 150;

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
			this.taskSessionBatchQueue.queue(projectId, summary);
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
