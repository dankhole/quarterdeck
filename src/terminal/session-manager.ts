// PTY-backed runtime composition root for task sessions and the project shell
// terminal. It wires process lifecycle, terminal protocol filtering, and
// summary updates for command-driven agents such as Claude Code, Codex, and
// shell sessions.
//
// Responsibility groups are extracted into focused modules:
//   session-manager-types.ts       — shared types, helpers, factories
//   session-lifecycle-controller.ts — task/shell lifecycle policy orchestration
//   session-lifecycle.ts           — task/shell spawn, exit handling, stale recovery primitives
//   session-transition-controller.ts — transition side effects + summary fanout
//   session-output-pipeline.ts     — PTY output processing pipeline
//   session-input-pipeline.ts      — user input routing pipeline
//   session-workspace-trust.ts     — workspace trust auto-confirm
//   session-interrupt-recovery.ts  — interrupt detection and recovery
//   session-auto-restart.ts        — auto-restart after unexpected exit
//   session-reconciliation-sweep.ts — periodic task session/process drift sweep
import type { RuntimeHookIngestRequest, RuntimeHookMetadata, RuntimeTaskSessionSummary } from "../core";
import { commitHookEventOrder, evaluateHookEventOrder, type HookEventOrderDecision } from "./hook-event-order";
import { processSessionInput } from "./session-input-pipeline";
import {
	markTaskSessionLaunchReady,
	markTaskSessionLaunchUserEngaged,
	type TaskSessionLaunchReadinessOutcome,
	waitForTaskSessionLaunchReadiness,
} from "./session-launch-readiness";
import { SessionLifecycleController, type TaskSessionStartWithReadinessResult } from "./session-lifecycle-controller";
import {
	createProcessEntry,
	hasLiveOutputListener,
	type ProcessEntry,
	resolveEffectiveTerminalRows,
	type StartShellSessionRequest,
	type StartTaskSessionRequest,
	type StopTaskSessionResult,
} from "./session-manager-types";
import { disableOutputOscIntercept, processTaskSessionOutput } from "./session-output-pipeline";
import { createReconciliationTimer, type ReconciliationTimer } from "./session-reconciliation-sweep";
import type { SessionSummaryStore } from "./session-summary-store";
import { SessionTransitionController } from "./session-transition-controller";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service";

export type { StartShellSessionRequest, StartTaskSessionRequest };

export class TerminalSessionManager implements TerminalSessionService {
	readonly store: SessionSummaryStore;
	private readonly entries = new Map<string, ProcessEntry>();
	private readonly transitions: SessionTransitionController;
	private readonly lifecycle: SessionLifecycleController;
	private readonly reconciliation: ReconciliationTimer;

	constructor(store: SessionSummaryStore) {
		this.store = store;
		this.transitions = new SessionTransitionController(this.store, this.entries);
		this.store.onChange((summary) => this.transitions.broadcastSummary(summary));
		this.lifecycle = new SessionLifecycleController({
			store: this.store,
			entries: this.entries,
			transitions: this.transitions,
			ensureProcessEntry: (taskId) => this.ensureProcessEntry(taskId),
			onTaskOutput: (entry, taskId, chunk) => this.handleTaskSessionOutput(entry, taskId, chunk),
		});
		this.reconciliation = createReconciliationTimer({
			entries: this.entries,
			store: this.store,
			applyTransitionEvent: (entry, event) => this.transitions.applyTransitionEvent(entry, event),
			recoverMissingLaunchPath: (entry, warningMessage) =>
				this.transitions.recoverMissingLaunchPath(entry, warningMessage),
		});
	}

	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		this.lifecycle.hydrateFromRecord(record);
	}

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const entry = this.ensureProcessEntry(taskId);

		const summary = this.store.getSummary(taskId);
		if (summary) {
			listener.onState?.(summary);
		}
		const hadLiveOutputListener = hasLiveOutputListener(entry);
		if (entry.active && listener.onOutput) {
			disableOutputOscIntercept(entry);
		}

		const listenerId = entry.listenerIdCounter;
		entry.listenerIdCounter += 1;
		entry.listeners.set(listenerId, listener);

		if (listener.onOutput) {
			entry.terminalStateMirror?.setBatching(false);
			if (!hadLiveOutputListener) {
				this.applyActiveTerminalGeometry(entry);
			}
		}

		return () => {
			const hadLiveOutputListenerBeforeDetach = hasLiveOutputListener(entry);
			entry.listeners.delete(listenerId);
			if (listener.onOutput && !hasLiveOutputListener(entry)) {
				entry.terminalStateMirror?.setBatching(true);
				if (hadLiveOutputListenerBeforeDetach) {
					this.applyActiveTerminalGeometry(entry);
				}
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
		return this.lifecycle.startTaskSession(request);
	}

	async startTaskSessionWithReadiness(request: StartTaskSessionRequest): Promise<TaskSessionStartWithReadinessResult> {
		return await this.lifecycle.startTaskSessionWithReadiness(request);
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		return this.lifecycle.startShellSession(request);
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		return this.lifecycle.recoverStaleSession(taskId);
	}

	/**
	 * Returns true while deleting the task's launch directory could invalidate
	 * an active or in-flight agent lifecycle operation.
	 */
	hasTaskSessionLifecycleActivity(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		return Boolean(
			entry?.active || entry?.pendingSessionStart || entry?.pendingAutoRestart || entry?.pendingStartupRecoveryToken,
		);
	}

	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		entry.pendingStartupRecoveryToken = null;
		markTaskSessionLaunchUserEngaged(entry.launchMonitor);
		if (!entry.active) {
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

	observeTaskSessionLaunchHook(taskId: string, metadata?: RuntimeHookMetadata): boolean {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return true;
		}
		markTaskSessionLaunchReady(entry.launchMonitor, metadata);
		return entry.launchMonitor?.outcome?.status !== "identity_mismatch";
	}

	beginStartupRecovery(taskId: string, token: string): boolean {
		const entry = this.ensureProcessEntry(taskId);
		if (entry.pendingStartupRecoveryToken && entry.pendingStartupRecoveryToken !== token) {
			return false;
		}
		entry.pendingStartupRecoveryToken = token;
		return true;
	}

	isStartupRecoveryCurrent(taskId: string, token: string): boolean {
		return this.entries.get(taskId)?.pendingStartupRecoveryToken === token;
	}

	isTaskSessionLaunchActive(taskId: string, sessionInstanceId: string, token: string): boolean {
		const entry = this.entries.get(taskId);
		return (
			entry?.pendingStartupRecoveryToken === token &&
			entry.launchMonitor?.sessionInstanceId === sessionInstanceId &&
			entry.launchMonitor.pid !== null &&
			entry.active?.session.pid === entry.launchMonitor.pid
		);
	}

	completeStartupRecovery(taskId: string, token: string): void {
		const entry = this.entries.get(taskId);
		if (entry?.pendingStartupRecoveryToken === token) {
			entry.pendingStartupRecoveryToken = null;
		}
	}

	finalizeStartupRecoveryFailure(
		taskId: string,
		token: string,
		options: {
			processStillRunning: boolean;
			clearResumeSessionId: boolean;
			warningMessage: string;
		},
	): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry || entry.pendingStartupRecoveryToken !== token) {
			return null;
		}
		return (
			this.transitions.applyTransitionEvent(entry, {
				type: "startup_recovery.exhausted",
				...options,
			})?.summary ?? null
		);
	}

	async waitForTaskSessionLaunch(
		taskId: string,
		sessionInstanceId: string,
		timeoutMs: number,
	): Promise<TaskSessionLaunchReadinessOutcome> {
		const monitor = this.entries.get(taskId)?.launchMonitor ?? null;
		if (!monitor || monitor.sessionInstanceId !== sessionInstanceId) {
			return { status: "superseded", sessionInstanceId };
		}
		return await waitForTaskSessionLaunchReadiness(monitor, timeoutMs);
	}

	async stopTaskSessionForStartupRecovery(
		taskId: string,
		sessionInstanceId: string,
		token: string,
		timeoutMs = 3_000,
	): Promise<"stopped" | "inactive" | "superseded" | "timeout"> {
		const entry = this.entries.get(taskId);
		if (
			!entry ||
			entry.pendingStartupRecoveryToken !== token ||
			entry.launchMonitor?.sessionInstanceId !== sessionInstanceId ||
			entry.launchMonitor.pid === null
		) {
			return "superseded";
		}
		if (!entry.active) {
			return "inactive";
		}
		if (entry.active.session.pid !== entry.launchMonitor.pid) {
			return "superseded";
		}
		await this.lifecycle.stopTaskSessionAndWaitForExit(taskId, timeoutMs, {
			preserveStartupRecovery: true,
		});
		return entry.active ? "timeout" : "stopped";
	}

	evaluateHookEventOrder(taskId: string, input: RuntimeHookIngestRequest): HookEventOrderDecision {
		return evaluateHookEventOrder(this.entries.get(taskId)?.hookEventOrder ?? null, input);
	}

	commitHookEventOrder(taskId: string, input: RuntimeHookIngestRequest, advanceTurn: boolean): void {
		commitHookEventOrder(this.entries.get(taskId)?.hookEventOrder ?? null, input, { advanceTurn });
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
		const safeBaseRows = Math.max(1, Math.floor(rows));
		const safePixelWidth = Number.isFinite(pixelWidth ?? Number.NaN) ? Math.floor(pixelWidth as number) : undefined;
		const safePixelHeight = Number.isFinite(pixelHeight ?? Number.NaN)
			? Math.floor(pixelHeight as number)
			: undefined;
		const normalizedPixelWidth = safePixelWidth !== undefined && safePixelWidth > 0 ? safePixelWidth : undefined;
		const normalizedPixelHeight = safePixelHeight !== undefined && safePixelHeight > 0 ? safePixelHeight : undefined;
		this.applyActiveTerminalGeometry(entry, {
			cols: safeCols,
			baseRows: safeBaseRows,
			pixelWidth: normalizedPixelWidth,
			pixelHeight: normalizedPixelHeight,
			force,
		});
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
		return this.lifecycle.stopTaskSession(taskId);
	}

	async stopTaskSessionAndWaitForExit(taskId: string, timeoutMs = 3_000): Promise<StopTaskSessionResult> {
		return this.lifecycle.stopTaskSessionAndWaitForExit(taskId, timeoutMs);
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		return this.lifecycle.markInterruptedAndStopAll();
	}

	startReconciliation(): void {
		this.reconciliation.start();
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

	private applyActiveTerminalGeometry(
		entry: ProcessEntry,
		options: {
			cols?: number;
			baseRows?: number;
			pixelWidth?: number;
			pixelHeight?: number;
			force?: boolean;
		} = {},
	): void {
		if (!entry.active) {
			return;
		}
		const cols = options.cols ?? entry.active.cols;
		const baseRows = options.baseRows ?? entry.active.baseRows;
		const rows = resolveEffectiveTerminalRows(entry.active.agentId, baseRows, hasLiveOutputListener(entry), {
			claudeFullscreenEnabled: entry.active.claudeFullscreenEnabled,
		});
		const dimensionsUnchanged = cols === entry.active.cols && rows === entry.active.rows;
		entry.active.session.resize(cols, rows, options.pixelWidth, options.pixelHeight);
		if (options.force && dimensionsUnchanged) {
			entry.active.session.sendSignal("SIGWINCH");
		}
		entry.terminalStateMirror?.resize(cols, rows);
		entry.active.cols = cols;
		entry.active.baseRows = baseRows;
		entry.active.rows = rows;
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
