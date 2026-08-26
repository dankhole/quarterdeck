// Task and shell session spawn/exit lifecycle.
// Extracted from session-manager.ts — handles PTY process creation, exit
// processing, auto-restart decisions, and stale session recovery.

import { randomUUID } from "node:crypto";

import type { RuntimeTaskSessionReviewReason, RuntimeTaskSessionSummary } from "../core";
import { createTaggedLogger } from "../core";
import { cleanStaleIndexLockForWorktree } from "../fs";
import type { PreparedAgentLaunch } from "./agent-session-adapters";
import { prepareAgentLaunch } from "./agent-session-adapters";
import { resolveClaudeRendererPolicy } from "./claude-renderer-policy";
import { shouldAutoConfirmClaudeWorkspaceTrust, stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import {
	isCodexResumeFailureSummary,
	STORED_CLAUDE_RESUME_FAILED_WARNING,
	STORED_CODEX_RESUME_FAILED_WARNING,
} from "./codex-resume-failure";
import { shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import { createHookEventOrderState } from "./hook-event-order";
import { PtySession, type PtySession as PtySessionInstance } from "./pty-session";
import { scheduleAutoRestart, shouldAutoRestart } from "./session-auto-restart";
import { clearInterruptRecoveryTimer } from "./session-interrupt-recovery";
import {
	createTaskSessionLaunchMonitor,
	markTaskSessionLaunchCancelled,
	markTaskSessionLaunchExited,
	markTaskSessionLaunchSuperseded,
} from "./session-launch-readiness";
import {
	buildTerminalEnvironment,
	createActiveProcessState,
	finalizeProcessExit,
	formatSpawnFailure,
	hasLiveOutputListener,
	normalizeDimension,
	type ProcessEntry,
	resolveEffectiveTerminalRowMultiplier,
	type StartShellSessionRequest,
	type StartTaskSessionRequest,
} from "./session-manager-types";
import { processShellSessionOutput } from "./session-output-pipeline";
import { appendLegacySemanticStateWarning, deriveStartupRecoveryPolicy } from "./session-startup-recovery-policy";
import { cloneSummary, type SessionTransitionEvent, type SessionTransitionResult } from "./session-summary-store";
import { TerminalStateMirror } from "./terminal-state-mirror";

const sessionLog = createTaggedLogger("session-mgr");

/**
 * Review reasons that represent completed agent work or an explicit review
 * request. These sessions should survive a server restart without being
 * re-marked as interrupted — the agent's work products are in the worktree
 * and the review state is meaningful.
 */
const TERMINAL_REVIEW_REASONS = new Set<RuntimeTaskSessionReviewReason>([
	"hook",
	"exit",
	"error",
	"attention",
	"interrupted",
	// Legacy persisted sessions may still carry this reason, but new sessions
	// no longer enter stalled review via reconciliation.
	"stalled",
]);

export function isTerminalReviewReason(reason: RuntimeTaskSessionReviewReason): boolean {
	return TERMINAL_REVIEW_REASONS.has(reason);
}

function writeSystemOutput(entry: ProcessEntry, message: string, summary: RuntimeTaskSessionSummary | null): void {
	const output = Buffer.from(`\r\n[quarterdeck] ${message}\r\n`, "utf8");
	entry.terminalStateMirror?.applyOutput(output);
	for (const listener of entry.listeners.values()) {
		listener.onOutput?.(output);
		if (summary) {
			listener.onState?.(cloneSummary(summary));
		}
	}
}

// ── Task session spawn ──────────────────────────────────────────────────────

export interface SpawnTaskSessionDeps {
	getSummary: (taskId: string) => RuntimeTaskSessionSummary | null;
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
	ensureEntry: (taskId: string) => RuntimeTaskSessionSummary;
	onOutput: (entry: ProcessEntry, taskId: string, chunk: Buffer) => void;
	onExit: (request: StartTaskSessionRequest, event: { exitCode: number | null }, session: PtySessionInstance) => void;
}

export interface SpawnTaskSessionResult {
	summary: RuntimeTaskSessionSummary;
	sessionInstanceId: string;
}

export async function spawnTaskSession(
	entry: ProcessEntry,
	request: StartTaskSessionRequest,
	deps: SpawnTaskSessionDeps,
): Promise<SpawnTaskSessionResult> {
	entry.pendingSessionStart = true;
	entry.pendingSessionStartSince = Date.now();
	const hookSessionInstanceId = randomUUID();
	markTaskSessionLaunchSuperseded(entry.launchMonitor);
	entry.launchMonitor = createTaskSessionLaunchMonitor({
		sessionInstanceId: hookSessionInstanceId,
		expectedSessionId:
			request.startupRecoveryToken && request.resumeConversation ? request.resumeSessionId : undefined,
	});
	entry.hookEventOrder = createHookEventOrderState(hookSessionInstanceId);

	const cols = normalizeDimension(request.cols, 120);
	const baseRows = normalizeDimension(request.rows, 40);
	const claudeRendererPolicy =
		request.agentId === "claude"
			? resolveClaudeRendererPolicy({
					fullscreenEnabled: request.claudeFullscreenEnabled,
					args: request.args,
					envOverrides: request.env,
				})
			: null;
	const claudeFullscreenEnabled = claudeRendererPolicy?.mode === "fullscreen";
	if (request.claudeFullscreenEnabled === true && claudeRendererPolicy?.mode === "classic") {
		sessionLog.warn("Claude fullscreen setting overridden by a classic-renderer constraint", {
			taskId: request.taskId,
			agentId: request.agentId,
			reason: claudeRendererPolicy.reason,
		});
	}
	const effectiveRowMultiplier = resolveEffectiveTerminalRowMultiplier(request.agentId, hasLiveOutputListener(entry), {
		claudeFullscreenEnabled,
	});
	const rows = baseRows * effectiveRowMultiplier;
	let terminalStateMirror: TerminalStateMirror;
	let launch: PreparedAgentLaunch;
	try {
		terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});

		launch = await prepareAgentLaunch({
			taskId: request.taskId,
			agentId: request.agentId,
			binary: request.binary,
			args: request.args,
			cwd: request.cwd,
			prompt: request.prompt,
			images: request.images,
			resumeConversation: request.resumeConversation,
			resumeSessionId: request.resumeSessionId,
			env: request.env,
			projectId: request.projectId,
			projectPath: request.projectPath,
			hookSessionInstanceId,
			claudeFullscreenEnabled,
			statuslineEnabled: request.statuslineEnabled,
			codexApprovalsReviewer: request.codexApprovalsReviewer,
			worktreeSystemPromptTemplate: request.worktreeSystemPromptTemplate,
		});
	} catch (error) {
		entry.pendingSessionStart = false;
		entry.pendingSessionStartSince = null;
		entry.hookEventOrder = null;
		markTaskSessionLaunchCancelled(entry.launchMonitor);
		throw error;
	}

	const env = buildTerminalEnvironment(request.env, launch.env);
	const commandBinary = launch.binary ?? request.binary;
	const commandArgs = [...launch.args];

	const willAutoTrust =
		shouldAutoConfirmClaudeWorkspaceTrust(request.agentId, request.cwd, request.projectPath) ||
		shouldAutoConfirmCodexWorkspaceTrust(request.agentId, request.cwd);
	const spawnData = {
		agentId: request.agentId,
		claudeFullscreenEnabled,
		binary: commandBinary,
		cwd: request.cwd,
		projectPath: request.projectPath ?? null,
		argCount: commandArgs.length,
		willAutoTrust,
	};
	sessionLog.debug("spawning task session", {
		taskId: request.taskId,
		...spawnData,
		resumeConversation: request.resumeConversation ?? false,
		resumeSessionId: request.resumeSessionId ?? null,
		preparedArgsPreview: commandArgs.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…(${a.length})` : a)),
	});

	let session: PtySession;
	let sessionForExit: PtySession | null = null;
	try {
		session = PtySession.spawn({
			binary: commandBinary,
			args: commandArgs,
			cwd: request.cwd,
			env,
			cols,
			rows,
			onData: (chunk) => deps.onOutput(entry, request.taskId, chunk),
			onExit: (event) => {
				if (!sessionForExit) {
					sessionLog.warn("task session exited before spawn handoff completed", {
						taskId: request.taskId,
						exitCode: event.exitCode,
					});
					return;
				}
				deps.onExit(request, event, sessionForExit);
			},
		});
		sessionForExit = session;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		sessionLog.error("failed to spawn task session", {
			taskId: request.taskId,
			agentId: request.agentId,
			binary: commandBinary,
			error: errorMessage,
		});
		entry.pendingSessionStart = false;
		entry.pendingSessionStartSince = null;
		entry.hookEventOrder = null;
		markTaskSessionLaunchCancelled(entry.launchMonitor);
		if (launch.cleanup) {
			void launch.cleanup().catch(() => {});
		}
		terminalStateMirror.dispose();
		deps.updateStore(request.taskId, {
			sessionInstanceId: hookSessionInstanceId,
			launchOperationId: request.launchOperationId ?? null,
			state: "failed",
			agentId: request.agentId,
			sessionLaunchPath: request.cwd,
			resumeSessionId: request.resumeConversation ? (request.resumeSessionId ?? null) : null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: "error",
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			stalledSince: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		throw new Error(formatSpawnFailure(commandBinary, error, "task"));
	}

	sessionLog.info("task session spawned successfully", {
		taskId: request.taskId,
		pid: session.pid,
		willAutoTrust,
	});

	entry.active = createActiveProcessState({
		session,
		sessionInstanceId: hookSessionInstanceId,
		launchOperationId: request.launchOperationId,
		agentId: request.agentId,
		claudeFullscreenEnabled,
		cols,
		baseRows,
		rows,
		willAutoTrust,
		launch,
	});
	if (entry.launchMonitor?.sessionInstanceId === hookSessionInstanceId) {
		entry.launchMonitor.pid = session.pid;
	}
	entry.pendingSessionStart = false;
	entry.pendingSessionStartSince = null;
	entry.terminalStateMirror = terminalStateMirror;
	if (!hasLiveOutputListener(entry)) {
		terminalStateMirror.setBatching(true);
	}

	const postSpawnResumeSessionId = request.resumeConversation ? (request.resumeSessionId ?? null) : null;
	const restoredSemanticStateIsUncertain = request.startupRecoveryReviewState?.reviewReason === "interrupted";
	sessionLog.debug("seeding summary for spawned task session", {
		taskId: request.taskId,
		state: restoredSemanticStateIsUncertain ? "interrupted" : request.awaitReview ? "awaiting_review" : "running",
		resumeConversation: request.resumeConversation ?? false,
		resumeSessionId: postSpawnResumeSessionId,
		sessionLaunchPath: request.cwd,
		pid: session.pid,
	});
	const summary = deps.updateStore(request.taskId, {
		sessionInstanceId: hookSessionInstanceId,
		launchOperationId: request.launchOperationId ?? null,
		state: restoredSemanticStateIsUncertain ? "interrupted" : request.awaitReview ? "awaiting_review" : "running",
		agentId: request.agentId,
		sessionLaunchPath: request.cwd,
		resumeSessionId: postSpawnResumeSessionId,
		pid: session.pid,
		startedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: request.awaitReview ? (request.startupRecoveryReviewState?.reviewReason ?? "attention") : null,
		exitCode: null,
		lastHookAt: request.startupRecoveryReviewState?.lastHookAt ?? null,
		latestHookActivity: request.startupRecoveryReviewState?.latestHookActivity
			? { ...request.startupRecoveryReviewState.latestHookActivity }
			: null,
		stalledSince: null,
		startupRecoveryRequired: false,
		startupRecoverySemanticStateUncertain: restoredSemanticStateIsUncertain,
		warningMessage: request.startupRecoveryWarningMessage ?? null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	});

	return {
		summary: summary ?? deps.ensureEntry(request.taskId),
		sessionInstanceId: hookSessionInstanceId,
	};
}

// ── Task session exit ───────────────────────────────────────────────────────

export interface TaskSessionExitDeps {
	getEntry: (taskId: string) => ProcessEntry | undefined;
	getSummary: (taskId: string) => RuntimeTaskSessionSummary | null;
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
	startTaskSession: (request: StartTaskSessionRequest) => Promise<RuntimeTaskSessionSummary>;
	applyTransitionEvent: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
}

export function handleTaskSessionExit(
	request: StartTaskSessionRequest,
	event: { exitCode: number | null },
	exitingSession: PtySessionInstance,
	deps: TaskSessionExitDeps,
): void {
	const currentSummaryAtExit = deps.getSummary(request.taskId);
	const currentEntry = deps.getEntry(request.taskId);
	if (!currentEntry?.active) {
		sessionLog.debug("task session exit ignored because no active session remains", {
			taskId: request.taskId,
			exitCode: event.exitCode,
			exitingPid: exitingSession.pid,
			currentState: currentSummaryAtExit?.state ?? null,
			currentReviewReason: currentSummaryAtExit?.reviewReason ?? null,
		});
		return;
	}
	if (currentEntry.active.session !== exitingSession) {
		sessionLog.warn("ignoring stale task session exit for replaced process", {
			taskId: request.taskId,
			exitCode: event.exitCode,
			exitingPid: exitingSession.pid,
			activePid: currentEntry.active.session.pid,
			currentState: currentSummaryAtExit?.state ?? null,
			currentReviewReason: currentSummaryAtExit?.reviewReason ?? null,
		});
		return;
	}
	markTaskSessionLaunchExited(currentEntry.launchMonitor, event.exitCode);

	const exitEventData = {
		exitCode: event.exitCode,
		wasInterrupted: exitingSession.wasInterrupted(),
		trustConfirmCount: currentEntry.active.workspaceTrustConfirmCount,
		timeInState: currentSummaryAtExit?.updatedAt ? Date.now() - currentSummaryAtExit.updatedAt : null,
		timeSinceLastHook: currentSummaryAtExit?.lastHookAt ? Date.now() - currentSummaryAtExit.lastHookAt : null,
	};
	sessionLog.info("task session process exited", {
		taskId: request.taskId,
		displaySummary: currentSummaryAtExit?.displaySummary ?? null,
		exitCode: event.exitCode,
		trustConfirmCount: exitEventData.trustConfirmCount,
	});

	stopWorkspaceTrustTimers(currentEntry.active);
	clearInterruptRecoveryTimer(currentEntry.active);

	const result = deps.applyTransitionEvent(currentEntry, {
		type: "process.exit",
		exitCode: event.exitCode,
		interrupted: currentEntry.active.session.wasInterrupted(),
	});

	const preExitState = currentSummaryAtExit?.state ?? "idle";
	if (request.startupRecoveryToken && currentEntry.pendingStartupRecoveryToken === request.startupRecoveryToken) {
		// The startup coordinator owns this process until readiness has remained
		// stable. Suppress the generic crash restart so it cannot race the
		// coordinator's exact-target retry.
		currentEntry.suppressAutoRestartOnExit = true;
	}
	const autoRestartDecision = shouldAutoRestart(currentEntry, preExitState);
	if (!autoRestartDecision.restart) {
		const skipData = {
			taskId: request.taskId,
			displaySummary: currentSummaryAtExit?.displaySummary ?? null,
			reason: autoRestartDecision.reason,
			preExitState,
			listenerCount: currentEntry.listeners.size,
			restartRequestKind: currentEntry.restartRequest?.kind ?? null,
			exitCode: event.exitCode,
			exitState: result?.summary?.state ?? null,
			exitReviewReason: result?.summary?.reviewReason ?? null,
		};
		if (autoRestartDecision.reason === "suppressed" || autoRestartDecision.reason === "not_running") {
			sessionLog.debug("auto-restart skipped on exit", skipData);
		} else {
			sessionLog.warn("auto-restart skipped on exit", skipData);
		}
	}
	const exitSummary = result?.summary ?? deps.getSummary(request.taskId);
	const cleanupFn = finalizeProcessExit(currentEntry, exitSummary, event.exitCode);
	// Trash/stop flows intentionally suppress auto-restart while the old PTY exits.
	// Do not let the resume-failure fallback below convert that explicit stop
	// into a fresh non-resume start; that is what cleared resumeSessionId before
	// the real untrash resume could use it.
	const wasExplicitStop = !autoRestartDecision.restart && autoRestartDecision.reason === "suppressed";

	if (autoRestartDecision.restart) {
		scheduleAutoRestart(currentEntry, {
			startTaskSession: (r) => deps.startTaskSession(r),
			updateStore: (id, patch) => deps.updateStore(id, patch),
			applyDenied: () => deps.applyTransitionEvent(currentEntry, { type: "autorestart.denied" }),
		});
	} else if (!wasExplicitStop && exitSummary?.state === "interrupted") {
		deps.applyTransitionEvent(currentEntry, { type: "autorestart.denied" });
	} else if (
		!wasExplicitStop &&
		request.resumeConversation &&
		preExitState === "awaiting_review" &&
		currentSummaryAtExit?.reviewReason === "attention" &&
		event.exitCode != null &&
		currentEntry.restartRequest?.kind === "task"
	) {
		const resumeExitData = {
			taskId: request.taskId,
			agentId: request.agentId,
			exitCode: event.exitCode,
			preExitState,
			preExitReviewReason: currentSummaryAtExit.reviewReason,
			resumeSessionId: request.resumeSessionId ?? null,
		};
		if (event.exitCode === 0 && !request.startupRecoveryToken) {
			// Keep the legacy fallback for explicit resume flows: a clean targeted
			// resume or continuation process can exit without leaving an interactive
			// session. Startup recovery owns its own exact-target bounded retry and
			// must never convert that failure into a fresh non-resume prompt.
			sessionLog.warn("resume exited before interactive session; scheduling fallback start", resumeExitData);
			scheduleAutoRestart(
				currentEntry,
				{
					startTaskSession: (r) => deps.startTaskSession(r),
					updateStore: (id, patch) => deps.updateStore(id, patch),
					applyDenied: () => deps.applyTransitionEvent(currentEntry, { type: "autorestart.denied" }),
				},
				{ skipContinueAttempt: true },
			);
		} else if (event.exitCode !== 0) {
			const failedStoredTargetedResume =
				(request.agentId === "codex" || request.agentId === "claude") && Boolean(request.resumeSessionId?.trim());
			const message = failedStoredTargetedResume
				? request.agentId === "claude"
					? STORED_CLAUDE_RESUME_FAILED_WARNING
					: STORED_CODEX_RESUME_FAILED_WARNING
				: `Resume failed before opening an interactive session (exit code ${event.exitCode}).`;
			sessionLog.warn("resume exited before interactive session; preserving failed resume", {
				...resumeExitData,
				clearedResumeSessionId: failedStoredTargetedResume,
			});
			const failedSummary = deps.updateStore(request.taskId, {
				state: "awaiting_review",
				reviewReason: "error",
				...(failedStoredTargetedResume ? { resumeSessionId: null } : {}),
				warningMessage: message,
			});
			writeSystemOutput(currentEntry, message, failedSummary);
		}
	}
	if (cleanupFn) {
		cleanupFn().catch(() => {});
	}
	void cleanStaleIndexLockForWorktree(request.cwd).catch(() => {});
}

// ── Shell session spawn ─────────────────────────────────────────────────────

export interface SpawnShellSessionDeps {
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
	ensureEntry: (taskId: string) => RuntimeTaskSessionSummary;
}

export async function spawnShellSession(
	entry: ProcessEntry,
	request: StartShellSessionRequest,
	deps: SpawnShellSessionDeps,
): Promise<RuntimeTaskSessionSummary> {
	const cols = normalizeDimension(request.cols, 120);
	const rows = normalizeDimension(request.rows, 40);
	const terminalStateMirror = new TerminalStateMirror(cols, rows, {
		onInputResponse: (data) => {
			if (!entry.active || hasLiveOutputListener(entry)) {
				return;
			}
			entry.active.session.write(data);
		},
	});
	const env = buildTerminalEnvironment(request.env);

	let session: PtySession;
	const sessionInstanceId = randomUUID();
	try {
		sessionLog.info("spawning shell session", {
			taskId: request.taskId,
			binary: request.binary,
			cwd: request.cwd,
			cols,
			rows,
		});
		session = PtySession.spawn({
			binary: request.binary,
			args: request.args ?? [],
			cwd: request.cwd,
			env,
			cols,
			rows,
			onData: (chunk) => processShellSessionOutput(entry, request.taskId, chunk),
			onExit: (event) => {
				if (!entry.active) {
					return;
				}
				stopWorkspaceTrustTimers(entry.active);
				clearInterruptRecoveryTimer(entry.active);
				sessionLog.info("shell session process exited", {
					taskId: request.taskId,
					exitCode: event.exitCode,
				});

				const summary = deps.updateStore(request.taskId, {
					state: entry.active.session.wasInterrupted() ? "interrupted" : "idle",
					reviewReason: entry.active.session.wasInterrupted() ? "interrupted" : null,
					exitCode: event.exitCode,
					pid: null,
				});
				// Shell stops use waitForExit too. The shared finalizer resolves
				// pending stopTaskSessionAndWaitForExit callers in addition to
				// notifying listeners and clearing the active process entry.
				const cleanupFn = finalizeProcessExit(entry, summary, event.exitCode);
				if (cleanupFn) {
					cleanupFn().catch(() => {});
				}
			},
		});
	} catch (error) {
		terminalStateMirror.dispose();
		deps.updateStore(request.taskId, {
			sessionInstanceId,
			launchOperationId: null,
			state: "failed",
			agentId: null,
			sessionLaunchPath: request.cwd,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: "error",
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			stalledSince: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		throw new Error(formatSpawnFailure(request.binary, error, "shell"));
	}
	sessionLog.info("shell session spawned successfully", {
		taskId: request.taskId,
		pid: session.pid,
		cwd: request.cwd,
	});

	entry.active = createActiveProcessState({
		session,
		sessionInstanceId,
		launchOperationId: null,
		agentId: null,
		cols,
		baseRows: rows,
		rows,
		willAutoTrust: false,
	});
	entry.terminalStateMirror = terminalStateMirror;
	if (!hasLiveOutputListener(entry)) {
		terminalStateMirror.setBatching(true);
	}

	const summary = deps.updateStore(request.taskId, {
		sessionInstanceId,
		launchOperationId: null,
		state: "running",
		agentId: null,
		sessionLaunchPath: request.cwd,
		pid: session.pid,
		startedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	});

	return summary ?? deps.ensureEntry(request.taskId);
}

// ── Stale session recovery ──────────────────────────────────────────────────

export interface RecoverStaleSessionDeps {
	getEntry: (taskId: string) => ProcessEntry | undefined;
	getSummary: (taskId: string) => RuntimeTaskSessionSummary | null;
	recoverStaleSession: (taskId: string) => RuntimeTaskSessionSummary | null;
	startTaskSession: (request: StartTaskSessionRequest) => Promise<RuntimeTaskSessionSummary>;
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
	applyTransitionEvent: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
}

export function recoverStaleSession(taskId: string, deps: RecoverStaleSessionDeps): RuntimeTaskSessionSummary | null {
	const entry = deps.getEntry(taskId);
	const summary = deps.getSummary(taskId);
	if (!summary) {
		return null;
	}
	if (entry?.active || (summary.state !== "running" && summary.state !== "awaiting_review")) {
		return summary;
	}

	if (entry?.pendingSessionStart || entry?.pendingStartupRecoveryToken) {
		return summary;
	}

	if (summary.state === "awaiting_review" && isTerminalReviewReason(summary.reviewReason)) {
		if (
			entry?.restartRequest?.kind === "task" &&
			!entry.pendingAutoRestart &&
			summary.reviewReason === "error" &&
			!isCodexResumeFailureSummary(summary)
		) {
			scheduleAutoRestart(entry, {
				startTaskSession: (r) => deps.startTaskSession(r),
				updateStore: (id, patch) => deps.updateStore(id, patch),
				applyDenied: () => deps.applyTransitionEvent(entry, { type: "autorestart.denied" }),
			});
		}
		return summary;
	}

	sessionLog.warn("recovering stale session to idle", {
		taskId,
		previousState: summary.state,
		previousReviewReason: summary.reviewReason,
		hasRestartRequest: entry?.restartRequest != null,
		restartRequestKind: entry?.restartRequest?.kind ?? null,
	});
	return deps.recoverStaleSession(taskId);
}

// ── Hydration ───────────────────────────────────────────────────────────────

export interface HydrationDeps {
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
	ensureProcessEntry: (taskId: string) => ProcessEntry;
}

export interface SessionHydrationCorrection {
	taskId: string;
	action: "marked_interrupted" | "stale_pid_cleared" | "legacy_semantic_state_uncertain";
	previousState: RuntimeTaskSessionSummary["state"];
	previousReviewReason: RuntimeTaskSessionReviewReason;
	hadPersistedPid: boolean;
	/** The old runtime owned a process that should be restored without changing review semantics. */
	requiresStartupRecovery: boolean;
}

/**
 * Hydrate both the summary store and the process entry map from persisted
 * session records. Sessions persisted as "running" are crash survivors — mark
 * them interrupted. Review state is durable user-facing meaning, so hydration
 * never rewrites a valid review reason merely because its old process is gone.
 * Instead, corrections flag interactive review processes for the bounded
 * startup coordinator while clearing their impossible persisted PID.
 */
export function hydrateSessionEntries(
	record: Record<string, RuntimeTaskSessionSummary>,
	deps: HydrationDeps,
): SessionHydrationCorrection[] {
	const corrections: SessionHydrationCorrection[] = [];
	for (const [taskId, summary] of Object.entries(record)) {
		deps.ensureProcessEntry(taskId);
		const recoveryPolicy = deriveStartupRecoveryPolicy(summary);
		const requiresStartupRecovery = recoveryPolicy.required;
		const uncertaintyWarning = recoveryPolicy.semanticStateUncertain
			? appendLegacySemanticStateWarning(summary.warningMessage)
			: summary.warningMessage;
		const shouldInterrupt =
			summary.state === "running" ||
			(summary.state === "awaiting_review" &&
				!isTerminalReviewReason(summary.reviewReason) &&
				summary.reviewReason !== "interrupted" &&
				summary.reviewReason !== "error" &&
				summary.reviewReason !== "exit");
		if (shouldInterrupt) {
			deps.updateStore(taskId, {
				state: "interrupted",
				reviewReason: "interrupted",
				pid: null,
				stalledSince: null,
				latestHookActivity: null,
				startupRecoveryRequired: true,
				startupRecoverySemanticStateUncertain: recoveryPolicy.semanticStateUncertain,
				warningMessage: uncertaintyWarning,
			});
			corrections.push({
				taskId,
				action: "marked_interrupted",
				previousState: summary.state,
				previousReviewReason: summary.reviewReason,
				hadPersistedPid: summary.pid !== null,
				requiresStartupRecovery: true,
			});
		} else if (summary.pid !== null) {
			// A persisted PID never represents a process owned by this runtime.
			// Clear impossible liveness without changing terminal review meaning.
			deps.updateStore(taskId, {
				pid: null,
				startupRecoveryRequired: requiresStartupRecovery,
				startupRecoverySemanticStateUncertain: recoveryPolicy.semanticStateUncertain,
				warningMessage: uncertaintyWarning,
			});
			corrections.push({
				taskId,
				action: "stale_pid_cleared",
				previousState: summary.state,
				previousReviewReason: summary.reviewReason,
				hadPersistedPid: true,
				requiresStartupRecovery,
			});
		} else if (recoveryPolicy.semanticStateUncertain) {
			deps.updateStore(taskId, {
				startupRecoveryRequired: true,
				startupRecoverySemanticStateUncertain: true,
				warningMessage: uncertaintyWarning,
			});
			corrections.push({
				taskId,
				action: "legacy_semantic_state_uncertain",
				previousState: summary.state,
				previousReviewReason: summary.reviewReason,
				hadPersistedPid: false,
				requiresStartupRecovery: true,
			});
		}
	}
	return corrections;
}
