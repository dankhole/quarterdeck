import { createTaggedLogger, type RuntimeTaskSessionSummary } from "../core";
import { stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import type { PtySession } from "./pty-session";
import { clearInterruptRecoveryTimer, type InterruptSignal } from "./session-interrupt-recovery";
import { markTaskSessionLaunchCancelled } from "./session-launch-readiness";
import {
	handleTaskSessionExit,
	hydrateSessionEntries,
	recoverStaleSession,
	type SessionHydrationCorrection,
	spawnShellSession,
	spawnTaskSession,
} from "./session-lifecycle";
import {
	cloneStartShellSessionRequest,
	cloneStartTaskSessionRequest,
	type NativeTaskSessionProcessIdentity,
	type ProcessEntry,
	type StartShellSessionRequest,
	type StartTaskSessionRequest,
	type StopTaskSessionResult,
	TaskSessionStartCancelledError,
	teardownActiveSession,
} from "./session-manager-types";
import type { SessionSummaryStore, SessionTransitionResult } from "./session-summary-store";
import type { SessionTransitionController } from "./session-transition-controller";

const sessionLog = createTaggedLogger("session-lifecycle");

export interface SessionLifecycleControllerOptions {
	store: SessionSummaryStore;
	entries: Map<string, ProcessEntry>;
	transitions: SessionTransitionController;
	ensureProcessEntry: (taskId: string) => ProcessEntry;
	onTaskOutput: (entry: ProcessEntry, taskId: string, chunk: Buffer) => void;
	onInterruptRecoveryApplied: (
		taskId: string,
		signal: InterruptSignal,
		result: (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null,
		sessionInstanceId: string,
	) => void;
}

export interface TaskSessionStartWithReadinessResult {
	summary: RuntimeTaskSessionSummary;
	sessionInstanceId: string | null;
	startedNewSession: boolean;
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
	private readonly onInterruptRecoveryApplied: SessionLifecycleControllerOptions["onInterruptRecoveryApplied"];
	private readonly inFlightTaskStarts = new Map<
		string,
		{ launchOperationId: string | null; promise: Promise<TaskSessionStartWithReadinessResult> }
	>();
	private shuttingDown = false;
	private lifecycleGeneration = 0;

	constructor(options: SessionLifecycleControllerOptions) {
		this.store = options.store;
		this.entries = options.entries;
		this.transitions = options.transitions;
		this.ensureProcessEntry = options.ensureProcessEntry;
		this.onTaskOutput = options.onTaskOutput;
		this.onInterruptRecoveryApplied = options.onInterruptRecoveryApplied;
	}

	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): SessionHydrationCorrection[] {
		this.store.hydrateFromRecord(record);
		return hydrateSessionEntries(record, {
			updateStore: (id, patch) => this.store.update(id, patch),
			ensureProcessEntry: (taskId) => this.ensureProcessEntry(taskId),
		});
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		return (await this.startTaskSessionWithReadiness(request)).summary;
	}

	getTaskSessionProcessIdentity(taskId: string): NativeTaskSessionProcessIdentity | null {
		const active = this.entries.get(taskId)?.active;
		if (!active) return null;
		return {
			pid: active.session.pid,
			sessionInstanceId: active.sessionInstanceId,
			launchOperationId: active.launchOperationId,
			agentId: active.agentId,
			binary: active.launchBinary,
			profileEnvironment: { ...active.launchProfileEnvironment },
		};
	}

	async startTaskSessionWithReadiness(request: StartTaskSessionRequest): Promise<TaskSessionStartWithReadinessResult> {
		if (this.shuttingDown) {
			throw new TaskSessionStartCancelledError();
		}
		const launchOperationId = request.launchOperationId?.trim() || null;
		const inFlight = this.inFlightTaskStarts.get(request.taskId);
		if (inFlight) {
			if (inFlight.launchOperationId !== launchOperationId) {
				throw new Error("A different task session launch is already in progress.");
			}
			return await inFlight.promise;
		}

		const promise = this.startTaskSessionOnce({
			...request,
			launchOperationId: launchOperationId ?? undefined,
		});
		this.inFlightTaskStarts.set(request.taskId, { launchOperationId, promise });
		try {
			return await promise;
		} finally {
			if (this.inFlightTaskStarts.get(request.taskId)?.promise === promise) {
				this.inFlightTaskStarts.delete(request.taskId);
			}
		}
	}

	private async startTaskSessionOnce(request: StartTaskSessionRequest): Promise<TaskSessionStartWithReadinessResult> {
		const lifecycleGeneration = this.lifecycleGeneration;
		const entry = this.ensureProcessEntry(request.taskId);
		const startupRecoveryToken = request.startupRecoveryToken?.trim() || null;
		if (startupRecoveryToken && entry.pendingStartupRecoveryToken !== startupRecoveryToken) {
			throw new Error("Startup recovery was cancelled before the task session could start.");
		}
		if (!startupRecoveryToken) {
			entry.pendingStartupRecoveryToken = null;
			markTaskSessionLaunchCancelled(entry.launchMonitor);
		}
		const restartRequest = cloneStartTaskSessionRequest(request);
		restartRequest.startupRecoveryToken = undefined;
		restartRequest.resumeSemanticState = undefined;
		restartRequest.startupRecoverySemanticStateUncertain = undefined;
		restartRequest.startupRecoveryWarningMessage = undefined;
		entry.restartRequest = {
			kind: "task",
			request: restartRequest,
		};
		const currentSummary = this.store.getSummary(request.taskId);
		sessionLog.debug("startTaskSession called", {
			taskId: request.taskId,
			agentId: request.agentId,
			hasLaunchPath: Boolean(request.cwd),
			resumeConversation: request.resumeConversation ?? false,
			hasResumeSessionId: Boolean(request.resumeSessionId),
			awaitReview: request.awaitReview ?? false,
			entryActive: Boolean(entry.active),
			entrySuppressAutoRestart: Boolean(entry.suppressAutoRestartOnExit),
			entryPendingStart: Boolean(entry.pendingSessionStart),
			pendingExitResolverCount: entry.pendingExitResolvers.length,
			currentState: currentSummary?.state ?? null,
			currentReviewReason: currentSummary?.reviewReason ?? null,
			currentPid: currentSummary?.pid ?? null,
			currentHasResumeSessionId: Boolean(currentSummary?.resumeSessionId),
			launchOperationId: request.launchOperationId ?? null,
			currentLaunchOperationId: currentSummary?.launchOperationId ?? null,
		});
		if (entry.active && entry.suppressAutoRestartOnExit) {
			sessionLog.warn("task session start requested while previous session is still exiting", {
				taskId: request.taskId,
				agentId: request.agentId,
				currentState: currentSummary?.state ?? null,
				currentReviewReason: currentSummary?.reviewReason ?? null,
				currentPid: currentSummary?.pid ?? entry.active.session.pid,
				resumeConversation: request.resumeConversation ?? false,
				awaitReview: request.awaitReview ?? false,
			});
			throw new Error("Task session is still shutting down. Wait a moment and try again.");
		}
		if (
			entry.active &&
			currentSummary &&
			(currentSummary.state === "running" || currentSummary.state === "awaiting_review")
		) {
			if (request.launchOperationId && entry.active.launchOperationId !== request.launchOperationId) {
				throw new Error("A different task session is already active.");
			}
			sessionLog.debug("startTaskSession short-circuit — existing active session reused", {
				taskId: request.taskId,
				currentState: currentSummary.state,
				currentPid: currentSummary.pid,
			});
			return {
				summary: currentSummary,
				sessionInstanceId: entry.active.sessionInstanceId,
				startedNewSession: false,
			};
		}

		teardownActiveSession(entry);

		const spawned = await spawnTaskSession(entry, request, {
			getSummary: (id) => this.store.getSummary(id),
			updateStore: (id, patch) => this.store.update(id, patch),
			ensureEntry: (id) => this.store.ensureEntry(id),
			onOutput: (e, taskId, chunk) => this.onTaskOutput(e, taskId, chunk),
			onExit: (req, event, session) => this.handleTaskSessionExit(req, event, session),
			isLaunchAllowed: () => !this.shuttingDown && this.lifecycleGeneration === lifecycleGeneration,
		});
		return {
			summary: this.store.getSummary(request.taskId) ?? spawned.summary,
			sessionInstanceId: spawned.sessionInstanceId,
			startedNewSession: true,
		};
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		if (this.shuttingDown) {
			throw new TaskSessionStartCancelledError();
		}
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

	failTargetedResumeIdentity(
		taskId: string,
		sessionInstanceId: string,
		warningMessage: string,
	): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active || entry.active.sessionInstanceId !== sessionInstanceId) {
			return this.store.getSummary(taskId);
		}

		// A replacement process that opened another provider conversation cannot
		// remain writable. Preserve the typed recovery error, discard automatic
		// restart ownership, and stop only the exact launch that reported the
		// mismatched identity.
		entry.restartRequest = null;
		entry.suppressAutoRestartOnExit = true;
		const result = this.transitions.applyTransitionEvent(entry, {
			type: "resume.failed",
			clearResumeSessionId: true,
			warningMessage,
		});
		const cleanupFn = entry.active.onSessionCleanup;
		entry.active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(entry.active);
		clearInterruptRecoveryTimer(entry.active);
		entry.active.session.stop({ interrupted: true });
		if (cleanupFn) {
			cleanupFn().catch(() => {});
		}
		return result?.summary ?? this.store.getSummary(taskId);
	}

	stopTaskSession(taskId: string, options?: { preserveStartupRecovery?: boolean }): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (entry && !options?.preserveStartupRecovery) {
			entry.pendingStartupRecoveryToken = null;
		}
		markTaskSessionLaunchCancelled(entry?.launchMonitor ?? null);
		if (!entry?.active) {
			sessionLog.debug("stopTaskSession no-op — no active session", {
				taskId,
				hasEntry: Boolean(entry),
			});
			return this.store.getSummary(taskId);
		}
		const stopResult = this.transitions.applyTransitionEvent(entry, { type: "user.stop" });
		sessionLog.debug("stopTaskSession invoked", {
			taskId,
			pid: entry.active.session.pid,
		});
		entry.suppressAutoRestartOnExit = true;
		const cleanupFn = entry.active.onSessionCleanup;
		entry.active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(entry.active);
		clearInterruptRecoveryTimer(entry.active);
		entry.active.session.stop({ interrupted: true });
		if (cleanupFn) {
			cleanupFn().catch(() => {});
		}
		return stopResult?.summary ?? this.store.getSummary(taskId);
	}

	async stopTaskSessionAndWaitForExit(
		taskId: string,
		timeoutMs = 3_000,
		requestedSessionInstanceId?: string,
		options?: { preserveStartupRecovery?: boolean },
	): Promise<StopTaskSessionResult> {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			sessionLog.debug("stopTaskSessionAndWaitForExit no-op — no active entry", {
				taskId,
				hasEntry: Boolean(entry),
			});
			return {
				summary: this.store.getSummary(taskId),
				requestedSessionInstanceId: requestedSessionInstanceId ?? null,
				didExit: true,
				outcome: "not_running",
			};
		}
		if (requestedSessionInstanceId && entry.active.sessionInstanceId !== requestedSessionInstanceId) {
			const message = "The requested task session was replaced before it could be stopped.";
			sessionLog.warn("task session stop rejected for stale session instance", {
				taskId,
				requestedSessionInstanceId,
				activeSessionInstanceId: entry.active.sessionInstanceId,
				currentPid: entry.active.session.pid,
			});
			return {
				summary: this.store.getSummary(taskId),
				requestedSessionInstanceId,
				didExit: false,
				outcome: "failed",
				error: message,
			};
		}
		const stoppedSessionInstanceId = entry.active.sessionInstanceId;
		sessionLog.debug("stopTaskSessionAndWaitForExit starting", {
			taskId,
			timeoutMs,
			existingResolverCount: entry.pendingExitResolvers.length,
			currentPid: entry.active.session.pid,
			sessionInstanceId: stoppedSessionInstanceId,
		});
		let resolveExit: (() => void) | null = null;
		const exitPromise = new Promise<void>((resolve) => {
			resolveExit = resolve;
			entry.pendingExitResolvers.push(resolve);
		});
		this.stopTaskSession(taskId, options);
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
		return {
			summary: this.store.getSummary(taskId),
			requestedSessionInstanceId: requestedSessionInstanceId ?? stoppedSessionInstanceId,
			didExit,
			outcome: didExit ? "exited" : "timed_out",
			...(didExit ? {} : { error: "Task session did not exit before the timeout." }),
		};
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		this.shuttingDown = true;
		this.lifecycleGeneration += 1;
		// The store preserves durable review semantics while clearing process
		// ownership; the historical method name remains for compatibility with
		// the shutdown coordinator boundary.
		const activeTaskIds: string[] = [];
		const forceInterruptedTaskIds = new Set<string>();
		const activeEntries: Array<{
			entry: ProcessEntry;
			active: NonNullable<ProcessEntry["active"]>;
		}> = [];
		for (const entry of this.entries.values()) {
			entry.pendingStartupRecoveryToken = null;
			markTaskSessionLaunchCancelled(entry.launchMonitor);
			if (!entry.active) {
				if (entry.pendingSessionStart || entry.pendingAutoRestart || this.inFlightTaskStarts.has(entry.taskId)) {
					activeTaskIds.push(entry.taskId);
					if (entry.pendingAutoRestart) {
						forceInterruptedTaskIds.add(entry.taskId);
					}
				}
				continue;
			}
			activeTaskIds.push(entry.taskId);
			// Shutdown is a terminal lifecycle boundary. Establish it before
			// signalling the PTY because node-pty may report exit immediately;
			// otherwise the exit path can classify a running task as a crash and
			// launch a replacement process while shutdown persistence is running.
			entry.suppressAutoRestartOnExit = true;
			activeEntries.push({ entry, active: entry.active });
		}

		const interrupted = this.store.markAllInterrupted(activeTaskIds, { forceInterruptedTaskIds });
		for (const { entry, active } of activeEntries) {
			// A coincident natural exit may already have finalized this exact PTY.
			if (entry.active !== active) {
				continue;
			}
			stopWorkspaceTrustTimers(active);
			clearInterruptRecoveryTimer(active);
			active.session.stop({ interrupted: true });
		}
		return interrupted;
	}

	async waitForShutdownQuiescence(): Promise<void> {
		const pending = new Set<Promise<unknown>>();
		for (const start of this.inFlightTaskStarts.values()) {
			pending.add(start.promise);
		}
		for (const entry of this.entries.values()) {
			if (entry.pendingAutoRestart) {
				pending.add(entry.pendingAutoRestart);
			}
		}
		await Promise.allSettled(pending);
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
			onInterruptRecoveryApplied: this.onInterruptRecoveryApplied,
		});
	}
}
