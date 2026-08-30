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
import { randomUUID } from "node:crypto";

import type {
	DiagnosticCaptureScope,
	RuntimeHookIngestRequest,
	RuntimeHookMetadata,
	RuntimeTaskSessionSummary,
} from "../core";
import { normalizeDiagnosticErrorClass } from "../core";
import type { RuntimeDiagnostics } from "../diagnostics";
import {
	STORED_CLAUDE_RESUME_FAILED_WARNING,
	STORED_CODEX_RESUME_FAILED_WARNING,
	STORED_PI_RESUME_FAILED_WARNING,
} from "./codex-resume-failure";
import {
	commitHookEventOrder,
	correlateClaudePermissionToolUseId,
	correlateCodexPermissionToolUseId,
	createHookEventOrderState,
	createProviderHookOrderObservation,
	evaluateHookEventOrder,
	type HookEventOrderDecision,
	restoreHookEventOrderState,
} from "./hook-event-order";
import {
	isExplicitUserSubmission,
	isImmediateInteractionSubmission,
	processSessionInput,
} from "./session-input-pipeline";
import { INTERRUPT_RECOVERY_DELAY_MS, type InterruptSignal } from "./session-interrupt-recovery";
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
	type NativeTaskSessionProcessIdentity,
	type ProcessEntry,
	resolveEffectiveTerminalRows,
	type StartShellSessionRequest,
	type StartTaskSessionRequest,
	type StopTaskSessionResult,
} from "./session-manager-types";
import { disableOutputOscIntercept, processTaskSessionOutput } from "./session-output-pipeline";
import { createReconciliationTimer, type ReconciliationTimer } from "./session-reconciliation-sweep";
import type { StartupRecoveryReviewState } from "./session-startup-recovery-policy";
import type { SessionTransitionEvent, SessionTransitionResult } from "./session-state-machine";
import type { SessionSummaryStore } from "./session-summary-store";
import { SessionTransitionController } from "./session-transition-controller";
import type {
	TerminalSessionInputOptions,
	TerminalSessionListener,
	TerminalSessionService,
} from "./terminal-session-service";

export type { StartShellSessionRequest, StartTaskSessionRequest };

export interface TerminalSessionManagerOptions {
	projectId?: string;
	diagnostics?: RuntimeDiagnostics;
}

export interface TerminalSessionManagerDiagnosticSnapshot {
	projectId: string | null;
	sessions: Array<{
		projectId: string | null;
		taskId: string;
		sessionInstanceId: string | null;
		hasSummary: boolean;
		hasProcessEntry: boolean;
		hasActiveProcess: boolean;
		state: RuntimeTaskSessionSummary["state"];
		reviewReason: RuntimeTaskSessionSummary["reviewReason"];
		agentId: RuntimeTaskSessionSummary["agentId"];
		pid: number | null;
		pidAlive: boolean | null;
		pendingSessionStart: boolean;
		pendingSince: number | null;
		exiting: boolean;
		suppressAutoRestartOnExit: boolean;
		autoRestartCount: number;
		listenerCount: number;
		hookCount: number;
		hookOrderingActive: boolean;
		hasResumeSessionId: boolean;
		startupRecoveryRequired: boolean;
		hasLaunchPath: boolean;
		mirror: ReturnType<NonNullable<ProcessEntry["terminalStateMirror"]>["getDiagnosticSnapshot"]> | null;
	}>;
}

interface ObservedSessionSummary {
	summary: RuntimeTaskSessionSummary;
	sessionInstanceId: string | null;
}

function isProcessAliveForDiagnostics(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

export class TerminalSessionManager implements TerminalSessionService {
	readonly store: SessionSummaryStore;
	private readonly entries = new Map<string, ProcessEntry>();
	private readonly transitions: SessionTransitionController;
	private readonly lifecycle: SessionLifecycleController;
	private readonly reconciliation: ReconciliationTimer;
	private readonly projectId: string | null;
	private readonly diagnostics: RuntimeDiagnostics | null;
	private readonly previousSummaries = new Map<string, ObservedSessionSummary>();

	constructor(store: SessionSummaryStore, options: TerminalSessionManagerOptions = {}) {
		this.store = store;
		this.projectId = options.projectId ?? null;
		this.diagnostics = options.diagnostics ?? null;
		this.transitions = new SessionTransitionController(this.store, this.entries);
		this.store.onChange((summary) => {
			this.observeSummaryChange(summary);
			this.transitions.broadcastSummary(summary);
		});
		this.lifecycle = new SessionLifecycleController({
			store: this.store,
			entries: this.entries,
			transitions: this.transitions,
			ensureProcessEntry: (taskId) => this.ensureProcessEntry(taskId),
			onTaskOutput: (entry, taskId, chunk) => this.handleTaskSessionOutput(entry, taskId, chunk),
			onInterruptRecoveryApplied: (taskId, signal, result, sessionInstanceId) =>
				this.recordInterruptRecoveryApplied(taskId, signal, result, sessionInstanceId),
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
		for (const [taskId, summary] of Object.entries(record)) {
			if (summary.sessionInstanceId) {
				const entry = this.ensureProcessEntry(taskId);
				entry.hookEventOrder = restoreHookEventOrderState({
					sessionInstanceId: summary.sessionInstanceId,
					observations: summary.recentProviderHookOrderObservations,
					recentDeliveryIds: summary.recentProviderHookDeliveryIds,
					outstandingInteraction: summary.outstandingInteraction,
				});
				entry.providerHookReplayBoundary = {
					context: "startup",
					sessionInstanceId: summary.sessionInstanceId,
					legacyOccurredAtFloor:
						summary.recentProviderHookOrderObservations.length === 0 ? summary.lastProviderHookOccurredAt : null,
					recentDeliveryIds: new Set(summary.recentProviderHookDeliveryIds),
					closedAt: null,
				};
			}
		}
		const corrections = this.lifecycle.hydrateFromRecord(record);
		for (const correction of corrections) {
			this.record(
				"session.persisted_state_reconciled",
				{
					action: correction.action,
					previousState: correction.previousState,
					previousReviewReason: correction.previousReviewReason,
					hadPersistedPid: correction.hadPersistedPid,
					requiresStartupRecovery: correction.requiresStartupRecovery,
				},
				correction.taskId,
				{ level: "warn" },
			);
		}
		for (const summary of this.store.listSummaries()) {
			this.previousSummaries.set(summary.taskId, {
				summary,
				sessionInstanceId: this.entries.get(summary.taskId)?.launchMonitor?.sessionInstanceId ?? null,
			});
		}
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
		return (await this.startTaskSessionWithReadiness(request)).summary;
	}

	async startTaskSessionWithReadiness(request: StartTaskSessionRequest): Promise<TaskSessionStartWithReadinessResult> {
		if (!request.startupRecoveryToken) {
			this.clearStartupRecoveryRequirement(request.taskId);
		}
		const operationId = randomUUID();
		this.record(
			"session.start_requested",
			{
				agentId: request.agentId,
				resumeRequested: request.resumeConversation === true,
				hasTargetResumeId: Boolean(request.resumeSessionId),
				startupRecovery: Boolean(request.startupRecoveryToken),
			},
			request.taskId,
			{ operationId },
		);
		try {
			const result = await this.lifecycle.startTaskSessionWithReadiness(request);
			this.record(
				"session.launch_prepared",
				{
					startedNewSession: result.startedNewSession,
					agentId: request.agentId,
				},
				request.taskId,
				{ operationId, sessionInstanceId: result.sessionInstanceId ?? undefined },
			);
			return result;
		} catch (error) {
			this.record(
				"session.start_rejected",
				{ errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError" },
				request.taskId,
				{ operationId, level: "warn" },
			);
			throw error;
		}
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		return this.lifecycle.startShellSession(request);
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		return this.lifecycle.recoverStaleSession(taskId);
	}

	/** Applies one native provider event through the canonical session reducer. */
	applyProviderHook(
		taskId: string,
		input: RuntimeHookIngestRequest,
	): (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null {
		const entry = this.entries.get(taskId);
		if (!entry || !this.store.getSummary(taskId)) {
			return null;
		}
		return this.transitions.applyTransitionEvent(entry, {
			type: "provider.hook",
			event: input.event,
			...(input.metadata ? { metadata: input.metadata } : {}),
			...(input.delivery ? { occurredAt: input.delivery.occurredAt, deliveryId: input.delivery.id } : {}),
			correlatedToolUseId:
				correlateClaudePermissionToolUseId(entry.hookEventOrder, input) ??
				correlateCodexPermissionToolUseId(entry.hookEventOrder, input),
			codexAutoReviewPermissionRequest:
				entry.restartRequest?.kind === "task" &&
				entry.restartRequest.request.agentId === "codex" &&
				entry.restartRequest.request.codexApprovalsReviewer === "auto_review",
		});
	}

	/** Provider-structured lifecycle events enter through the same canonical reducer as native hooks. */
	applyStructuredTransition(
		taskId: string,
		transition: Extract<SessionTransitionEvent, { type: `structured.${string}` }>,
	): (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null {
		this.store.ensureEntry(taskId);
		return this.transitions.applyTransitionEvent(this.ensureProcessEntry(taskId), transition);
	}

	applyStructuredLaunchPathMissing(
		taskId: string,
		warningMessage: string,
	): (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null {
		this.store.ensureEntry(taskId);
		return this.transitions.applyTransitionEvent(this.ensureProcessEntry(taskId), {
			type: "reconciliation.launch_path_missing",
			warningMessage,
		});
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

	/** Exact live PTY identity for server-owned execution-owner fencing. */
	getTaskSessionProcessIdentity(taskId: string): NativeTaskSessionProcessIdentity | null {
		return this.lifecycle.getTaskSessionProcessIdentity(taskId);
	}

	writeInput(taskId: string, data: Buffer, options?: TerminalSessionInputOptions): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active || entry.active.session.wasInterrupted()) {
			return null;
		}
		const summaryBeforeInput = this.store.getSummary(taskId);
		const summary = processSessionInput(
			entry,
			taskId,
			data,
			{
				getSummary: (id) => this.store.getSummary(id),
				getEntry: (id) => this.entries.get(id),
				applyTransitionEvent: (e, ev) => this.transitions.applyTransitionEvent(e, ev),
				onInterruptRecoveryScheduled: (signal) => {
					this.record(
						"session.interrupt_recovery_scheduled",
						{ signal, delayMs: INTERRUPT_RECOVERY_DELAY_MS },
						taskId,
						{ sessionInstanceId: entry.active?.sessionInstanceId },
					);
				},
				onInterruptRecoveryApplied: (signal, result) => {
					this.recordInterruptRecoveryApplied(taskId, signal, result, entry.active?.sessionInstanceId);
				},
			},
			options,
		);
		// Recovery ownership changes only after the live PTY accepted the write.
		// A stale or non-browser client cannot cancel recovery merely by
		// addressing a processless or explicitly stopping task.
		entry.pendingStartupRecoveryToken = null;
		this.clearStartupRecoveryRequirement(taskId);
		markTaskSessionLaunchUserEngaged(entry.launchMonitor);
		if (
			options?.explicitUserSubmission === true ||
			isExplicitUserSubmission(data) ||
			isImmediateInteractionSubmission(summaryBeforeInput, data)
		) {
			this.record("session.input_submitted", {}, taskId);
		}
		return summary;
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
		const previousOutcome = entry.launchMonitor?.outcome?.status ?? null;
		markTaskSessionLaunchReady(entry.launchMonitor, metadata);
		const mismatch = entry.launchMonitor?.outcome;
		if (
			mismatch?.status === "identity_mismatch" &&
			previousOutcome !== "identity_mismatch" &&
			!entry.pendingStartupRecoveryToken
		) {
			const summary = this.store.getSummary(taskId);
			const warningMessage =
				summary?.agentId === "claude"
					? STORED_CLAUDE_RESUME_FAILED_WARNING
					: summary?.agentId === "pi"
						? STORED_PI_RESUME_FAILED_WARNING
						: STORED_CODEX_RESUME_FAILED_WARNING;
			const failedSummary = this.lifecycle.failTargetedResumeIdentity(
				taskId,
				mismatch.sessionInstanceId,
				warningMessage,
			);
			const output = Buffer.from(`\r\n[quarterdeck] ${warningMessage}\r\n`, "utf8");
			entry.terminalStateMirror?.applyOutput(output);
			for (const listener of entry.listeners.values()) {
				listener.onOutput?.(output);
			}
			this.record(
				"session.resume_identity_mismatch",
				{
					agentId: summary?.agentId ?? null,
					hasExpectedSessionId: Boolean(mismatch.expectedSessionId),
					hasObservedSessionId: Boolean(mismatch.observedSessionId),
					state: failedSummary?.state ?? null,
				},
				taskId,
				{ level: "warn", sessionInstanceId: mismatch.sessionInstanceId },
			);
		}
		return mismatch?.status !== "identity_mismatch";
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
			entry.active?.sessionInstanceId === sessionInstanceId &&
			entry.active?.session.pid === entry.launchMonitor.pid
		);
	}

	completeStartupRecovery(taskId: string, token: string): void {
		const entry = this.entries.get(taskId);
		if (entry?.pendingStartupRecoveryToken === token) {
			entry.pendingStartupRecoveryToken = null;
			this.clearStartupRecoveryRequirement(taskId);
		}
	}

	finalizeStartupRecoveryFailure(
		taskId: string,
		token: string,
		options: {
			processStillRunning: boolean;
			clearResumeSessionId: boolean;
			warningMessage: string;
			fallbackReviewState: StartupRecoveryReviewState | null;
		},
	): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry || entry.pendingStartupRecoveryToken !== token) {
			return null;
		}
		// Exhaustion is the terminal outcome for coordinator-owned recovery.
		// Discard the cached automatic restart request so a later socket attach
		// or delayed process exit cannot replay it outside the bounded policy.
		// An explicit user Restart prepares and installs a fresh request.
		entry.pendingStartupRecoveryToken = null;
		entry.restartRequest = null;
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
		await this.lifecycle.stopTaskSessionAndWaitForExit(taskId, timeoutMs, sessionInstanceId, {
			preserveStartupRecovery: true,
		});
		return entry.active ? "timeout" : "stopped";
	}

	evaluateHookEventOrder(taskId: string, input: RuntimeHookIngestRequest): HookEventOrderDecision {
		const entry = this.entries.get(taskId);
		if (
			entry &&
			this.transitions.canApplyReplayedProviderHook(entry, {
				type: "provider.hook",
				event: input.event,
				...(input.metadata ? { metadata: input.metadata } : {}),
				...(input.delivery ? { occurredAt: input.delivery.occurredAt, deliveryId: input.delivery.id } : {}),
			}) &&
			!entry.hookEventOrder
		) {
			const sessionInstanceId = input.metadata?.sessionInstanceId?.trim();
			if (sessionInstanceId) entry.hookEventOrder = createHookEventOrderState(sessionInstanceId);
		}
		const decision = evaluateHookEventOrder(entry?.hookEventOrder ?? null, input);
		this.record(
			decision.accepted ? "hook.order_accepted" : "hook.order_rejected",
			{
				event: input.event,
				hookEventName: input.metadata?.hookEventName ?? null,
				reason: decision.accepted ? null : decision.reason,
			},
			taskId,
			{
				deliveryId: input.delivery?.id,
				sessionInstanceId: input.metadata?.sessionInstanceId ?? undefined,
				level: decision.accepted ? "debug" : "warn",
				essential: !decision.accepted,
			},
		);
		return decision;
	}

	commitHookEventOrder(taskId: string, input: RuntimeHookIngestRequest, advanceTurn: boolean): void {
		commitHookEventOrder(this.entries.get(taskId)?.hookEventOrder ?? null, input, { advanceTurn });
		if (advanceTurn) {
			this.store.recordProviderHookReceipt(taskId, createProviderHookOrderObservation(input));
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
		this.clearStartupRecoveryRequirement(taskId);
		this.record("session.stop_requested", { waitForExit: false }, taskId);
		return this.lifecycle.stopTaskSession(taskId);
	}

	async stopTaskSessionAndWaitForExit(
		taskId: string,
		timeoutMs = 3_000,
		sessionInstanceId?: string,
	): Promise<StopTaskSessionResult> {
		this.clearStartupRecoveryRequirement(taskId);
		const startedAt = Date.now();
		this.record("session.stop_requested", { waitForExit: true, timeoutMs }, taskId, {
			sessionInstanceId,
		});
		const result = await this.lifecycle.stopTaskSessionAndWaitForExit(taskId, timeoutMs, sessionInstanceId);
		const timedOut = result.outcome === "timed_out";
		this.record(
			timedOut ? "session.stop_wait_timed_out" : "session.stop_wait_completed",
			{
				durationMs: Date.now() - startedAt,
				outcome: result.outcome,
			},
			taskId,
			{ level: timedOut ? "warn" : "info", sessionInstanceId },
		);
		return result;
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		return this.lifecycle.markInterruptedAndStopAll();
	}

	async waitForShutdownQuiescence(): Promise<void> {
		await this.lifecycle.waitForShutdownQuiescence();
	}

	private clearStartupRecoveryRequirement(taskId: string): void {
		if (this.store.getSummary(taskId)?.startupRecoveryRequired === true) {
			this.store.update(taskId, { startupRecoveryRequired: false });
		}
	}

	startReconciliation(): void {
		this.reconciliation.start();
	}

	stopReconciliation(): void {
		this.reconciliation.stop();
	}

	getDiagnosticSnapshot(scope: Readonly<DiagnosticCaptureScope> = {}): TerminalSessionManagerDiagnosticSnapshot {
		const summaries = new Map(this.store.listSummaries().map((summary) => [summary.taskId, summary]));
		const taskIds = new Set([...summaries.keys(), ...this.entries.keys()]);
		return {
			projectId: this.projectId,
			sessions: Array.from(taskIds)
				.filter((taskId) => !scope.taskId || taskId === scope.taskId)
				.flatMap((taskId) => {
					const summary = summaries.get(taskId) ?? null;
					const entry = this.entries.get(taskId) ?? null;
					const sessionInstanceId = entry?.launchMonitor?.sessionInstanceId ?? null;
					if (scope.sessionInstanceId && sessionInstanceId !== scope.sessionInstanceId) return [];
					const pid = summary?.pid ?? entry?.active?.session.pid ?? null;
					return [
						{
							projectId: this.projectId,
							taskId,
							sessionInstanceId,
							hasSummary: summary !== null,
							hasProcessEntry: entry !== null,
							hasActiveProcess: entry?.active !== null && entry?.active !== undefined,
							state: summary?.state ?? "idle",
							reviewReason: summary?.reviewReason ?? null,
							agentId: summary?.agentId ?? null,
							pid,
							pidAlive: pid === null ? null : isProcessAliveForDiagnostics(pid),
							pendingSessionStart: entry?.pendingSessionStart ?? false,
							pendingSince: entry?.pendingSessionStartSince ?? null,
							exiting: Boolean(entry?.active?.session.wasInterrupted()),
							suppressAutoRestartOnExit: entry?.suppressAutoRestartOnExit ?? false,
							autoRestartCount: entry?.autoRestartTimestamps.length ?? 0,
							listenerCount: entry?.listeners.size ?? 0,
							hookCount: entry?.hookCount ?? 0,
							hookOrderingActive: entry?.hookEventOrder !== null && entry?.hookEventOrder !== undefined,
							hasResumeSessionId: Boolean(summary?.resumeSessionId?.trim()),
							startupRecoveryRequired: summary?.startupRecoveryRequired === true,
							hasLaunchPath: Boolean(summary?.sessionLaunchPath),
							mirror: entry?.terminalStateMirror?.getDiagnosticSnapshot() ?? null,
						},
					];
				}),
		};
	}

	// ── Private helpers ──────────────────────────────────────────────────

	private handleTaskSessionOutput(entry: ProcessEntry, taskId: string, chunk: Buffer): void {
		processTaskSessionOutput(entry, taskId, chunk, {
			getSummary: (id) => this.store.getSummary(id),
			updateStore: (id, patch) => this.store.update(id, patch),
			applyTransitionEvent: (e, ev) => this.transitions.applyTransitionEvent(e, ev),
		});
	}

	private recordInterruptRecoveryApplied(
		taskId: string,
		signal: InterruptSignal,
		result: (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null,
		sessionInstanceId: string | undefined,
	): void {
		this.record(
			"session.interrupt_recovery_applied",
			{
				signal,
				changed: result?.changed === true,
				nextState: result?.summary.state ?? null,
				nextReviewReason: result?.summary.reviewReason ?? null,
			},
			taskId,
			{ sessionInstanceId },
		);
	}

	private observeSummaryChange(summary: RuntimeTaskSessionSummary): void {
		const previousObservation = this.previousSummaries.get(summary.taskId) ?? null;
		const previous = previousObservation?.summary ?? null;
		this.transitions.observeSummaryChange(previous, summary);
		const entry = this.entries.get(summary.taskId);
		const sessionInstanceId = entry?.launchMonitor?.sessionInstanceId ?? null;
		this.previousSummaries.set(summary.taskId, { summary, sessionInstanceId });
		if (summary.pid !== null && summary.pid !== previous?.pid) {
			this.record(
				"session.process_spawned",
				{
					pid: summary.pid,
					agentId: summary.agentId,
					state: summary.state,
				},
				summary.taskId,
				{ sessionInstanceId: sessionInstanceId ?? undefined },
			);
		}
		if (previous?.pid !== null && previous?.pid !== undefined && previous.pid !== summary.pid) {
			this.record(
				"session.process_exit_observed",
				{
					pid: previous.pid,
					exitCode: summary.exitCode,
					nextState: summary.state,
					nextReviewReason: summary.reviewReason,
				},
				summary.taskId,
				{
					sessionInstanceId: previousObservation?.sessionInstanceId ?? undefined,
					level: summary.exitCode === 0 ? "info" : "warn",
				},
			);
		}
		if (previous && (previous.state !== summary.state || previous.reviewReason !== summary.reviewReason)) {
			this.record(
				"session.transition_applied",
				{
					previousState: previous.state,
					previousReviewReason: previous.reviewReason,
					nextState: summary.state,
					nextReviewReason: summary.reviewReason,
				},
				summary.taskId,
				{ sessionInstanceId: sessionInstanceId ?? undefined },
			);
		}
	}

	private record(
		name: string,
		payload: unknown,
		taskId: string,
		options: {
			operationId?: string;
			sessionInstanceId?: string;
			deliveryId?: string;
			level?: "debug" | "info" | "warn" | "error";
			essential?: boolean;
		} = {},
	): void {
		this.diagnostics?.recordEvent(
			name,
			payload,
			{
				...(this.projectId ? { projectId: this.projectId } : {}),
				taskId,
				...(options.operationId ? { operationId: options.operationId } : {}),
				...(options.sessionInstanceId ? { sessionInstanceId: options.sessionInstanceId } : {}),
				...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
			},
			{
				level: options.level,
				essential: options.essential ?? true,
			},
		);
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
		if (options.force && dimensionsUnchanged) {
			entry.active.session.forceRedraw(cols, rows, options.pixelWidth, options.pixelHeight);
		} else {
			entry.active.session.resize(cols, rows, options.pixelWidth, options.pixelHeight);
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
