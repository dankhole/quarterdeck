import type { LogEntry, RuntimeTaskSessionSummary } from "../core";
import type { TerminalSessionManager } from "../terminal";

const TASK_SESSION_STREAM_BATCH_MS = 150;
const DEBUG_LOG_BATCH_MS = 150;

export interface CreateRuntimeStateMessageBatcherDependencies {
	hasClients: () => boolean;
	onTaskSessionBatch: (projectId: string, summaries: RuntimeTaskSessionSummary[]) => void;
	onTaskNotificationBatch: (projectId: string, summaries: RuntimeTaskSessionSummary[]) => void;
	onProjectsRefreshRequested: (preferredCurrentProjectId: string | null) => void;
	onDebugLogBatch: (entries: LogEntry[]) => void;
}

export class RuntimeStateMessageBatcher {
	private readonly terminalSummaryUnsubscribes = new Map<string, () => void>();
	private readonly pendingSummaries = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	private readonly summaryTimers = new Map<string, NodeJS.Timeout>();
	private readonly pendingDebugLogEntries: LogEntry[] = [];
	private debugLogTimer: NodeJS.Timeout | null = null;

	constructor(private readonly deps: CreateRuntimeStateMessageBatcherDependencies) {}

	trackTerminalManager(projectId: string, manager: TerminalSessionManager): void {
		if (this.terminalSummaryUnsubscribes.has(projectId)) {
			return;
		}
		const unsubscribe = manager.store.onChange((summary) => {
			this.queueSummaryBroadcast(projectId, summary);
		});
		this.terminalSummaryUnsubscribes.set(projectId, unsubscribe);
	}

	queueDebugLogEntry(entry: LogEntry): void {
		if (!this.deps.hasClients()) {
			return;
		}
		this.pendingDebugLogEntries.push(entry);
		if (this.debugLogTimer !== null) {
			return;
		}
		this.debugLogTimer = setTimeout(() => this.flushDebugLogEntries(), DEBUG_LOG_BATCH_MS);
		this.debugLogTimer.unref();
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
		this.disposeSummaryBroadcast(projectId);
	}

	close(): void {
		if (this.debugLogTimer) {
			clearTimeout(this.debugLogTimer);
			this.debugLogTimer = null;
		}
		this.pendingDebugLogEntries.length = 0;

		for (const timer of this.summaryTimers.values()) {
			clearTimeout(timer);
		}
		this.summaryTimers.clear();
		this.pendingSummaries.clear();

		for (const unsubscribe of this.terminalSummaryUnsubscribes.values()) {
			try {
				unsubscribe();
			} catch {
				// Ignore listener cleanup errors during shutdown.
			}
		}
		this.terminalSummaryUnsubscribes.clear();
	}

	private queueSummaryBroadcast(projectId: string, summary: RuntimeTaskSessionSummary): void {
		const pending = this.pendingSummaries.get(projectId) ?? new Map<string, RuntimeTaskSessionSummary>();
		pending.set(summary.taskId, summary);
		this.pendingSummaries.set(projectId, pending);
		if (this.summaryTimers.has(projectId)) {
			return;
		}
		const timer = setTimeout(() => {
			this.summaryTimers.delete(projectId);
			this.flushSummaries(projectId);
		}, TASK_SESSION_STREAM_BATCH_MS);
		timer.unref();
		this.summaryTimers.set(projectId, timer);
	}

	private flushSummaries(projectId: string): void {
		const pending = this.pendingSummaries.get(projectId);
		if (!pending || pending.size === 0) {
			return;
		}
		this.pendingSummaries.delete(projectId);
		const summaries = Array.from(pending.values());
		this.deps.onTaskSessionBatch(projectId, summaries);
		this.deps.onTaskNotificationBatch(projectId, summaries);
		this.deps.onProjectsRefreshRequested(projectId);
	}

	private disposeSummaryBroadcast(projectId: string): void {
		const timer = this.summaryTimers.get(projectId);
		if (timer) {
			clearTimeout(timer);
		}
		this.summaryTimers.delete(projectId);
		this.pendingSummaries.delete(projectId);
	}

	private flushDebugLogEntries(): void {
		this.debugLogTimer = null;
		if (this.pendingDebugLogEntries.length === 0 || !this.deps.hasClients()) {
			this.pendingDebugLogEntries.length = 0;
			return;
		}
		const entries = this.pendingDebugLogEntries.splice(0);
		this.deps.onDebugLogBatch(entries);
	}
}
