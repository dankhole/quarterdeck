// PTY-backed runtime for task sessions and the project shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, and shell sessions.
//
// Responsibility groups are extracted into focused modules:
//   session-manager-types.ts       — shared types, helpers, factories
//   session-lifecycle.ts           — task/shell spawn, exit handling, stale recovery, hydration
//   session-transition-controller.ts — transition side effects + summary fanout
//   session-output-pipeline.ts     — PTY output processing pipeline
//   session-input-pipeline.ts      — user input routing pipeline
//   session-workspace-trust.ts     — workspace trust auto-confirm
//   session-interrupt-recovery.ts  — interrupt detection and recovery
//   session-auto-restart.ts        — auto-restart after unexpected exit
//   session-reconciliation-sweep.ts — periodic reconciliation sweep
import { createTaggedLogger, type RuntimeTaskSessionSummary } from "../core";
import { stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import type { PtySession } from "./pty-session";
import { processSessionInput } from "./session-input-pipeline";
import { clearInterruptRecoveryTimer } from "./session-interrupt-recovery";
import {
	handleTaskSessionExit,
	hydrateSessionEntries,
	recoverStaleSession,
	spawnShellSession,
	spawnTaskSession,
} from "./session-lifecycle";
import {
	createProcessEntry,
	hasLiveOutputListener,
	type ProcessEntry,
	type StartShellSessionRequest,
	type StartTaskSessionRequest,
	teardownActiveSession,
} from "./session-manager-types";
import { disableOutputOscIntercept, processTaskSessionOutput } from "./session-output-pipeline";
import { createReconciliationTimer, type ReconciliationTimer } from "./session-reconciliation-sweep";
import type { SessionSummaryStore } from "./session-summary-store";
import { SessionTransitionController } from "./session-transition-controller";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service";

export type { StartShellSessionRequest, StartTaskSessionRequest };

const sessionLog = createTaggedLogger("session-mgr");

export class TerminalSessionManager implements TerminalSessionService {
	readonly store: SessionSummaryStore;
	private readonly entries = new Map<string, ProcessEntry>();
	private readonly transitions: SessionTransitionController;
	private readonly reconciliation: ReconciliationTimer;

	constructor(store: SessionSummaryStore) {
		this.store = store;
		this.transitions = new SessionTransitionController(this.store, this.entries);
		this.store.onChange((summary) => this.transitions.broadcastSummary(summary));
		this.reconciliation = createReconciliationTimer({
			entries: this.entries,
			store: this.store,
			applyTransitionEvent: (entry, event) => this.transitions.applyTransitionEvent(entry, event),
		});
	}

	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		this.store.hydrateFromRecord(record);
		hydrateSessionEntries(record, {
			updateStore: (id, patch) => this.store.update(id, patch),
			ensureProcessEntry: (taskId) => this.ensureProcessEntry(taskId),
		});
	}

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const entry = this.ensureProcessEntry(taskId);

		const summary = this.store.getSummary(taskId);
		if (summary) {
			listener.onState?.(summary);
		}
		if (entry.active && listener.onOutput) {
			disableOutputOscIntercept(entry);
		}

		const listenerId = entry.listenerIdCounter;
		entry.listenerIdCounter += 1;
		entry.listeners.set(listenerId, listener);

		if (listener.onOutput) {
			entry.terminalStateMirror?.setBatching(false);
		}

		return () => {
			entry.listeners.delete(listenerId);
			if (listener.onOutput && !hasLiveOutputListener(entry)) {
				entry.terminalStateMirror?.setBatching(true);
			}
		};
	}

	async getRestoreSnapshot(taskId: string) {
		const entry = this.entries.get(taskId);
		if (!entry?.terminalStateMirror) {
			return null;
		}
		return await entry.terminalStateMirror.getSnapshot();
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureProcessEntry(request.taskId);
		entry.restartRequest = {
			kind: "task",
			request: {
				...request,
				args: [...request.args],
				images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
				env: request.env ? { ...request.env } : undefined,
			},
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
			onOutput: (e, taskId, chunk) => this.handleTaskSessionOutput(e, taskId, chunk),
			onExit: (req, event, session) => this.handleTaskSessionExit(req, event, session),
		});
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureProcessEntry(request.taskId);
		entry.restartRequest = {
			kind: "shell",
			request: {
				...request,
				args: request.args ? [...request.args] : undefined,
				env: request.env ? { ...request.env } : undefined,
			},
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
			startTaskSession: (r) => this.startTaskSession(r),
			updateStore: (id, patch) => this.store.update(id, patch),
			applyTransitionEvent: (entry, event) => this.transitions.applyTransitionEvent(entry, event),
		});
	}

	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return null;
		}
		return processSessionInput(entry, taskId, data, {
			getSummary: (id) => this.store.getSummary(id),
			updateStore: (id, patch) => this.store.update(id, patch),
			getEntry: (id) => this.entries.get(id),
			applyTransitionEvent: (e, ev) => this.transitions.applyTransitionEvent(e, ev),
		});
	}

	recordHookReceived(taskId: string): void {
		const entry = this.entries.get(taskId);
		if (entry) {
			entry.hookCount += 1;
		}
	}

	resize(
		taskId: string,
		cols: number,
		rows: number,
		pixelWidth?: number,
		pixelHeight?: number,
		force?: boolean,
	): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		const safeCols = Math.max(1, Math.floor(cols));
		const safeRows = Math.max(1, Math.floor(rows)) * entry.active.agentTerminalRowMultiplier;
		const safePixelWidth = Number.isFinite(pixelWidth ?? Number.NaN) ? Math.floor(pixelWidth as number) : undefined;
		const safePixelHeight = Number.isFinite(pixelHeight ?? Number.NaN)
			? Math.floor(pixelHeight as number)
			: undefined;
		const normalizedPixelWidth = safePixelWidth !== undefined && safePixelWidth > 0 ? safePixelWidth : undefined;
		const normalizedPixelHeight = safePixelHeight !== undefined && safePixelHeight > 0 ? safePixelHeight : undefined;
		const dimensionsUnchanged = safeCols === entry.active.cols && safeRows === entry.active.rows;
		entry.active.session.resize(safeCols, safeRows, normalizedPixelWidth, normalizedPixelHeight);
		if (force && dimensionsUnchanged) {
			entry.active.session.sendSignal("SIGWINCH");
		}
		entry.terminalStateMirror?.resize(safeCols, safeRows);
		entry.active.cols = safeCols;
		entry.active.rows = safeRows;
		return true;
	}

	pauseOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.pause();
		return true;
	}

	resumeOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.resume();
		return true;
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

	startReconciliation(repoPath?: string): void {
		this.reconciliation.start(repoPath);
	}

	stopReconciliation(): void {
		this.reconciliation.stop();
	}

	// ── Private helpers ──────────────────────────────────────────────────

	private handleTaskSessionOutput(entry: ProcessEntry, taskId: string, chunk: Buffer): void {
		processTaskSessionOutput(entry, taskId, chunk, {
			getSummary: (id) => this.store.getSummary(id),
			updateStore: (id, patch) => this.store.update(id, patch),
			applyTransitionEvent: (e, ev) => this.transitions.applyTransitionEvent(e, ev),
		});
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
			startTaskSession: (r) => this.startTaskSession(r),
			applyTransitionEvent: (e, ev) => this.transitions.applyTransitionEvent(e, ev),
		});
	}

	private ensureProcessEntry(taskId: string): ProcessEntry {
		const existing = this.entries.get(taskId);
		if (existing) {
			return existing;
		}
		this.store.ensureEntry(taskId);
		const created = createProcessEntry(taskId);
		this.entries.set(taskId, created);
		return created;
	}
}
