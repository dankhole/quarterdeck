import { createTaggedLogger, type RuntimeTaskSessionSummary } from "../core";
import { stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import type { PtySession } from "./pty-session";
import { clearInterruptRecoveryTimer } from "./session-interrupt-recovery";
import {
	handleTaskSessionExit,
	hydrateSessionEntries,
	recoverStaleSession,
	spawnShellSession,
	spawnTaskSession,
} from "./session-lifecycle";
import {
	cloneStartShellSessionRequest,
	cloneStartTaskSessionRequest,
	type ProcessEntry,
	type StartShellSessionRequest,
	type StartTaskSessionRequest,
	teardownActiveSession,
} from "./session-manager-types";
import type { SessionSummaryStore } from "./session-summary-store";
import type { SessionTransitionController } from "./session-transition-controller";

const sessionLog = createTaggedLogger("session-lifecycle");

export interface SessionLifecycleControllerOptions {
	store: SessionSummaryStore;
	entries: Map<string, ProcessEntry>;
	transitions: SessionTransitionController;
	ensureProcessEntry: (taskId: string) => ProcessEntry;
	onTaskOutput: (entry: ProcessEntry, taskId: string, chunk: Buffer) => void;
}

/**
 * Owns task/shell lifecycle policy around process starts, explicit stops,
 * stale recovery, and shutdown interruption. TerminalSessionManager keeps the
 * registry and transport wiring; this class decides how lifecycle operations
 * mutate that registry and the summary store.
 */
export class SessionLifecycleController {
	private readonly store: SessionSummaryStore;
	private readonly entries: Map<string, ProcessEntry>;
	private readonly transitions: SessionTransitionController;
	private readonly ensureProcessEntry: (taskId: string) => ProcessEntry;
	private readonly onTaskOutput: (entry: ProcessEntry, taskId: string, chunk: Buffer) => void;

	constructor(options: SessionLifecycleControllerOptions) {
		this.store = options.store;
		this.entries = options.entries;
		this.transitions = options.transitions;
		this.ensureProcessEntry = options.ensureProcessEntry;
		this.onTaskOutput = options.onTaskOutput;
	}

	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		this.store.hydrateFromRecord(record);
		hydrateSessionEntries(record, {
			updateStore: (id, patch) => this.store.update(id, patch),
			ensureProcessEntry: (taskId) => this.ensureProcessEntry(taskId),
		});
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureProcessEntry(request.taskId);
		entry.restartRequest = {
			kind: "task",
			request: cloneStartTaskSessionRequest(request),
		};
		const currentSummary = this.store.getSummary(request.taskId);
		sessionLog.debug("startTaskSession called", {
			taskId: request.taskId,
			agentId: request.agentId,
			cwd: request.cwd,
			resumeConversation: request.resumeConversation ?? false,
			resumeSessionId: request.resumeSessionId ?? null,
			awaitReview: request.awaitReview ?? false,
			entryActive: Boolean(entry.active),
			entrySuppressAutoRestart: Boolean(entry.suppressAutoRestartOnExit),
			entryPendingStart: Boolean(entry.pendingSessionStart),
			pendingExitResolverCount: entry.pendingExitResolvers.length,
			currentState: currentSummary?.state ?? null,
			currentReviewReason: currentSummary?.reviewReason ?? null,
			currentPid: currentSummary?.pid ?? null,
			currentResumeSessionId: currentSummary?.resumeSessionId ?? null,
		});
		if (
			entry.active &&
			currentSummary &&
			(currentSummary.state === "running" || currentSummary.state === "awaiting_review")
		) {
			if (entry.suppressAutoRestartOnExit) {
				sessionLog.warn("task session start requested while previous session is still exiting", {
					taskId: request.taskId,
					agentId: request.agentId,
					currentState: currentSummary.state,
					currentReviewReason: currentSummary.reviewReason,
					currentPid: currentSummary.pid,
					resumeConversation: request.resumeConversation ?? false,
					awaitReview: request.awaitReview ?? false,
				});
				throw new Error("Task session is still shutting down. Wait a moment and try again.");
			}
			sessionLog.debug("startTaskSession short-circuit — existing active session reused", {
				taskId: request.taskId,
				currentState: currentSummary.state,
				currentPid: currentSummary.pid,
			});
			return currentSummary;
		}

		teardownActiveSession(entry);

		return spawnTaskSession(entry, request, {
			getSummary: (id) => this.store.getSummary(id),
			updateStore: (id, patch) => this.store.update(id, patch),
			ensureEntry: (id) => this.store.ensureEntry(id),
			onOutput: (e, taskId, chunk) => this.onTaskOutput(e, taskId, chunk),
			onExit: (req, event, session) => this.handleTaskSessionExit(req, event, session),
		});
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureProcessEntry(request.taskId);
		entry.restartRequest = {
			kind: "shell",
			request: cloneStartShellSessionRequest(request),
		};
		const currentSummary = this.store.getSummary(request.taskId);
		if (entry.active && currentSummary?.state === "running") {
			return currentSummary;
		}

		teardownActiveSession(entry);

		return spawnShellSession(entry, request, {
			updateStore: (id, patch) => this.store.update(id, patch),
			ensureEntry: (id) => this.store.ensureEntry(id),
		});
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		return recoverStaleSession(taskId, {
			getEntry: (id) => this.entries.get(id),
			getSummary: (id) => this.store.getSummary(id),
			recoverStaleSession: (id) => this.store.recoverStaleSession(id),
			startTaskSession: (request) => this.startTaskSession(request),
			updateStore: (id, patch) => this.store.update(id, patch),
			applyTransitionEvent: (entry, event) => this.transitions.applyTransitionEvent(entry, event),
		});
	}

	stopTaskSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			sessionLog.debug("stopTaskSession no-op — no active session", {
				taskId,
				hasEntry: Boolean(entry),
			});
			return this.store.getSummary(taskId);
		}
		sessionLog.debug("stopTaskSession invoked", {
			taskId,
			pid: entry.active.session.pid,
		});
		entry.suppressAutoRestartOnExit = true;
		const cleanupFn = entry.active.onSessionCleanup;
		entry.active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(entry.active);
		clearInterruptRecoveryTimer(entry.active);
		entry.active.session.stop();
		if (cleanupFn) {
			cleanupFn().catch(() => {});
		}
		return this.store.getSummary(taskId);
	}

	async stopTaskSessionAndWaitForExit(taskId: string, timeoutMs = 3_000): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			sessionLog.debug("stopTaskSessionAndWaitForExit no-op — no active entry", {
				taskId,
				hasEntry: Boolean(entry),
			});
			return this.store.getSummary(taskId);
		}
		sessionLog.debug("stopTaskSessionAndWaitForExit starting", {
			taskId,
			timeoutMs,
			existingResolverCount: entry.pendingExitResolvers.length,
			currentPid: entry.active.session.pid,
		});
		let resolveExit: (() => void) | null = null;
		const exitPromise = new Promise<void>((resolve) => {
			resolveExit = resolve;
			entry.pendingExitResolvers.push(resolve);
		});
		this.stopTaskSession(taskId);
		const didExit = await new Promise<boolean>((resolve) => {
			const timeoutHandle = setTimeout(() => {
				if (resolveExit) {
					entry.pendingExitResolvers = entry.pendingExitResolvers.filter((candidate) => candidate !== resolveExit);
				}
				resolve(false);
			}, timeoutMs);
			void exitPromise.then(() => {
				clearTimeout(timeoutHandle);
				resolve(true);
			});
		});
		if (!didExit) {
			const latestSummary = this.store.getSummary(taskId);
			sessionLog.warn("task session did not exit before timeout", {
				taskId,
				timeoutMs,
				currentState: latestSummary?.state ?? null,
				currentReviewReason: latestSummary?.reviewReason ?? null,
				currentPid: latestSummary?.pid ?? null,
			});
		} else {
			sessionLog.debug("stopTaskSessionAndWaitForExit observed clean exit", { taskId });
		}
		return this.store.getSummary(taskId);
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		const activeTaskIds: string[] = [];
		for (const entry of this.entries.values()) {
			if (!entry.active) {
				continue;
			}
			activeTaskIds.push(entry.taskId);
			stopWorkspaceTrustTimers(entry.active);
			clearInterruptRecoveryTimer(entry.active);
			entry.active.session.stop({ interrupted: true });
		}
		return this.store.markAllInterrupted(activeTaskIds);
	}

	private handleTaskSessionExit(
		request: StartTaskSessionRequest,
		event: { exitCode: number | null },
		session: PtySession,
	): void {
		handleTaskSessionExit(request, event, session, {
			getEntry: (id) => this.entries.get(id),
			getSummary: (id) => this.store.getSummary(id),
			updateStore: (id, patch) => this.store.update(id, patch),
			startTaskSession: (nextRequest) => this.startTaskSession(nextRequest),
			applyTransitionEvent: (entry, nextEvent) => this.transitions.applyTransitionEvent(entry, nextEvent),
		});
	}
}
