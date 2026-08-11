import { deriveTaskIndicatorState, type LogEntry, type RuntimeTaskSessionSummary } from "../core";
import type { TerminalSessionManager } from "../terminal";

const TASK_SESSION_STREAM_BATCH_MS = 150;
const DEBUG_LOG_BATCH_MS = 150;

interface RuntimeTaskSessionEvent {
	projectId: string;
	summaries: RuntimeTaskSessionSummary[];
	notificationSummaries: RuntimeTaskSessionSummary[];
	refreshProjects: boolean;
}

interface RuntimeTaskSessionDeliveryClassification {
	broadcastNotification: boolean;
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

	// Project summaries currently project an in-progress board card into Review
	// only while its live session is awaiting_review. Other summary fields do not
	// affect project-list counts and should not rebuild every project's scoreboard.
	const refreshProjects = (previous.state === "awaiting_review") !== (next.state === "awaiting_review");

	return {
		broadcastNotification,
		refreshProjects,
	};
}

interface CreateRuntimeStateTaskSessionEventDeliveryDependencies {
	onTaskSessionBatch: (projectId: string, summaries: RuntimeTaskSessionSummary[]) => void;
	onTaskNotificationBatch: (projectId: string, summaries: RuntimeTaskSessionSummary[]) => void;
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
			refreshProjects: updates.some((update) => update.refreshProjects),
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
