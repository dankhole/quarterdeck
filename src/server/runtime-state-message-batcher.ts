import type { LogEntry, RuntimeTaskSessionSummary } from "../core";
import type { TerminalSessionManager } from "../terminal";

const TASK_SESSION_STREAM_BATCH_MS = 150;
const DEBUG_LOG_BATCH_MS = 150;

export interface CreateRuntimeStateMessageBatcherDependencies {
	hasClients: () => boolean;
	onTaskSessionBatch: (workspaceId: string, summaries: RuntimeTaskSessionSummary[]) => void;
	onTaskNotificationBatch: (workspaceId: string, summaries: RuntimeTaskSessionSummary[]) => void;
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

	trackTerminalManager(workspaceId: string, manager: TerminalSessionManager): void {
		if (this.terminalSummaryUnsubscribes.has(workspaceId)) {
			return;
		}
		const unsubscribe = manager.store.onChange((summary) => {
			this.queueSummaryBroadcast(workspaceId, summary);
		});
		this.terminalSummaryUnsubscribes.set(workspaceId, unsubscribe);
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

	disposeWorkspace(workspaceId: string): void {
		const unsubscribe = this.terminalSummaryUnsubscribes.get(workspaceId);
		if (unsubscribe) {
			try {
				unsubscribe();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		this.terminalSummaryUnsubscribes.delete(workspaceId);
		this.disposeSummaryBroadcast(workspaceId);
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

	private queueSummaryBroadcast(workspaceId: string, summary: RuntimeTaskSessionSummary): void {
		const pending = this.pendingSummaries.get(workspaceId) ?? new Map<string, RuntimeTaskSessionSummary>();
		pending.set(summary.taskId, summary);
		this.pendingSummaries.set(workspaceId, pending);
		if (this.summaryTimers.has(workspaceId)) {
			return;
		}
		const timer = setTimeout(() => {
			this.summaryTimers.delete(workspaceId);
			this.flushSummaries(workspaceId);
		}, TASK_SESSION_STREAM_BATCH_MS);
		timer.unref();
		this.summaryTimers.set(workspaceId, timer);
	}

	private flushSummaries(workspaceId: string): void {
		const pending = this.pendingSummaries.get(workspaceId);
		if (!pending || pending.size === 0) {
			return;
		}
		this.pendingSummaries.delete(workspaceId);
		const summaries = Array.from(pending.values());
		this.deps.onTaskSessionBatch(workspaceId, summaries);
		this.deps.onTaskNotificationBatch(workspaceId, summaries);
		this.deps.onProjectsRefreshRequested(workspaceId);
	}

	private disposeSummaryBroadcast(workspaceId: string): void {
		const timer = this.summaryTimers.get(workspaceId);
		if (timer) {
			clearTimeout(timer);
		}
		this.summaryTimers.delete(workspaceId);
		this.pendingSummaries.delete(workspaceId);
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
