// Task and shell session spawn/exit lifecycle.
// Extracted from session-manager.ts — handles PTY process creation, exit
// processing, auto-restart decisions, and stale session recovery.

import { randomUUID } from "node:crypto";

import type { RuntimeTaskSessionReviewReason, RuntimeTaskSessionSummary } from "../core";
import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import { cleanStaleIndexLockForWorktree } from "../fs";
import type { PreparedAgentLaunch } from "./agent-session-adapters";
import { prepareAgentLaunch } from "./agent-session-adapters";
import { resolveClaudeRendererPolicy } from "./claude-renderer-policy";
import { shouldAutoConfirmClaudeWorkspaceTrust, stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import {
	isCodexResumeFailureSummary,
	STORED_CLAUDE_RESUME_FAILED_WARNING,
	STORED_CODEX_RESUME_FAILED_WARNING,
	STORED_PI_RESUME_FAILED_WARNING,
} from "./codex-resume-failure";
import { shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import { createHookEventOrderState } from "./hook-event-order";
import { type PtyExitEvent, PtySession, type PtySession as PtySessionInstance } from "./pty-session";
import { scheduleAutoRestart, shouldAutoRestart } from "./session-auto-restart";
import { clearInterruptRecoveryTimer, type InterruptSignal } from "./session-interrupt-recovery";
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
	TaskSessionStartCancelledError,
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
	isLaunchAllowed: () => boolean;
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
	entry.providerHookReplayBoundary = null;
	entry.launchMonitor = createTaskSessionLaunchMonitor({
		sessionInstanceId: hookSessionInstanceId,
		expectedSessionId: request.resumeConversation ? request.resumeSessionId : undefined,
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
	let sessionForCallbacks: PtySession | null = null;
	try {
		terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!sessionForCallbacks || entry.active?.session !== sessionForCallbacks || hasLiveOutputListener(entry)) {
					return;
				}
				sessionForCallbacks.write(data);
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
			claudeLaunchPermissionMode: request.claudeLaunchPermissionMode,
			statuslineEnabled: request.statuslineEnabled,
			codexApprovalsReviewer: request.codexApprovalsReviewer,
			piToolApprovalsEnabled: request.piToolApprovalsEnabled,
			worktreeSystemPromptTemplate: request.worktreeSystemPromptTemplate,
		});
	} catch (error) {
		entry.pendingSessionStart = false;
		entry.pendingSessionStartSince = null;
		entry.hookEventOrder = null;
		markTaskSessionLaunchCancelled(entry.launchMonitor);
		throw error;
	}

	if (!deps.isLaunchAllowed()) {
		entry.pendingSessionStart = false;
		entry.pendingSessionStartSince = null;
		entry.hookEventOrder = null;
		markTaskSessionLaunchCancelled(entry.launchMonitor);
		if (launch.cleanup) {
			await launch.cleanup().catch(() => undefined);
		}
		terminalStateMirror.dispose();
		throw new TaskSessionStartCancelledError();
	}

	const env = buildTerminalEnvironment(request.env, launch.env);
	const commandBinary = launch.binary ?? request.binary;
	const commandArgs = [...launch.args];
	const launchProfileEnvironment = {
		...(env.CODEX_HOME !== undefined ? { CODEX_HOME: env.CODEX_HOME } : {}),
		...(env.CLAUDE_CONFIG_DIR !== undefined ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}),
		...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
	};

	const willAutoTrust =
		shouldAutoConfirmClaudeWorkspaceTrust(request.agentId, request.cwd, request.projectPath) ||
		shouldAutoConfirmCodexWorkspaceTrust(request.agentId, request.cwd);
	const spawnData = {
		agentId: request.agentId,
		claudeFullscreenEnabled,
		hasBinary: commandBinary.length > 0,
		hasLaunchPath: request.cwd.length > 0,
		hasProjectPath: Boolean(request.projectPath),
		hasCodexProfile: launchProfileEnvironment.CODEX_HOME !== undefined,
		hasClaudeProfile: launchProfileEnvironment.CLAUDE_CONFIG_DIR !== undefined,
		hasHomeProfile: launchProfileEnvironment.HOME !== undefined,
		argCount: commandArgs.length,
		willAutoTrust,
	};
	sessionLog.debug("spawning task session", {
		taskId: request.taskId,
		...spawnData,
		resumeConversation: request.resumeConversation ?? false,
		hasResumeSessionId: Boolean(request.resumeSessionId?.trim()),
	});

	let session: PtySession;
	let callbacksReady = false;
	const preHandoffOutput: Buffer[] = [];
	let preHandoffExit: PtyExitEvent | null = null;
	try {
		session = PtySession.spawn({
			binary: commandBinary,
			args: commandArgs,
			cwd: request.cwd,
			env,
			cols,
			rows,
			onData: (chunk) => {
				if (!callbacksReady) {
					preHandoffOutput.push(Buffer.from(chunk));
					return;
				}
				if (entry.active?.session !== sessionForCallbacks) {
					return;
				}
				deps.onOutput(entry, request.taskId, chunk);
			},
			onExit: (event) => {
				if (!callbacksReady) {
					preHandoffExit = event;
					sessionLog.warn("task session exited before spawn handoff completed", {
						taskId: request.taskId,
						exitCode: event.exitCode,
					});
					return;
				}
				if (!sessionForCallbacks) return;
				deps.onExit(request, event, sessionForCallbacks);
			},
		});
		sessionForCallbacks = session;
	} catch (error) {
		sessionLog.error("failed to spawn task session", {
			taskId: request.taskId,
			agentId: request.agentId,
			hasBinary: commandBinary.length > 0,
			errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
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
			state: "awaiting_review",
			agentId: request.agentId,
			sessionLaunchPath: request.cwd,
			resumeSessionId: request.resumeConversation ? (request.resumeSessionId ?? null) : null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: "error",
			exitCode: null,
			lastHookAt: null,
			lastProviderHookOccurredAt: null,
			recentProviderHookDeliveryIds: [],
			recentProviderHookOrderObservations: [],
			latestHookActivity: null,
			outstandingInteraction: null,
			nativeWorkEvidence: null,
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
		launchBinary: commandBinary,
		launchProfileEnvironment,
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
	const resumeSemanticState = request.resumeSemanticState;
	const restoredSemanticStateIsUncertain = request.startupRecoverySemanticStateUncertain === true;
	// Spawning a PTY proves only that the interaction surface exists. A fresh or
	// replacement native agent remains conservative Review until a current
	// launch-scoped provider hook supplies positive Running evidence.
	const restoredState: RuntimeTaskSessionSummary["state"] = "awaiting_review";
	const restoredReviewReason =
		resumeSemanticState?.reviewReason ?? (request.awaitReview ? "interrupted" : "unconfirmed");
	sessionLog.debug("seeding summary for spawned task session", {
		taskId: request.taskId,
		state: restoredState,
		resumeConversation: request.resumeConversation ?? false,
		hasResumeSessionId: Boolean(postSpawnResumeSessionId),
		hasSessionLaunchPath: request.cwd.length > 0,
		pid: session.pid,
	});
	const summary = deps.updateStore(request.taskId, {
		sessionInstanceId: hookSessionInstanceId,
		launchOperationId: request.launchOperationId ?? null,
		state: restoredState,
		agentId: request.agentId,
		sessionLaunchPath: request.cwd,
		resumeSessionId: postSpawnResumeSessionId,
		pid: session.pid,
		startedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: restoredReviewReason,
		exitCode: null,
		lastHookAt: resumeSemanticState?.lastHookAt ?? null,
		lastProviderHookOccurredAt: null,
		recentProviderHookDeliveryIds: [],
		recentProviderHookOrderObservations: [],
		latestHookActivity: resumeSemanticState?.latestHookActivity
			? { ...resumeSemanticState.latestHookActivity }
			: null,
		outstandingInteraction: resumeSemanticState?.outstandingInteraction
			? {
					...resumeSemanticState.outstandingInteraction,
					sessionInstanceId: hookSessionInstanceId,
				}
			: null,
		nativeWorkEvidence: null,
		stalledSince: null,
		startupRecoveryRequired: false,
		startupRecoverySemanticStateUncertain: restoredSemanticStateIsUncertain,
		warningMessage: request.startupRecoveryWarningMessage ?? null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	});
	callbacksReady = true;
	if (entry.active?.session === sessionForCallbacks) {
		for (const chunk of preHandoffOutput) {
			deps.onOutput(entry, request.taskId, chunk);
		}
		if (preHandoffExit) {
			deps.onExit(request, preHandoffExit, sessionForCallbacks);
		}
	}

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
	onInterruptRecoveryApplied?: (
		taskId: string,
		signal: InterruptSignal,
		result: (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null,
		sessionInstanceId: string,
	) => void;
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
	const active = currentEntry.active;
	const pendingInterruptSignal = active.interruptRecoverySignal;
	const wasInterrupted = exitingSession.wasInterrupted() || pendingInterruptSignal !== null;

	const exitEventData = {
		exitCode: event.exitCode,
		wasInterrupted,
		trustConfirmCount: active.workspaceTrustConfirmCount,
		timeInState: currentSummaryAtExit?.updatedAt ? Date.now() - currentSummaryAtExit.updatedAt : null,
		timeSinceLastHook: currentSummaryAtExit?.lastHookAt ? Date.now() - currentSummaryAtExit.lastHookAt : null,
	};
	sessionLog.info("task session process exited", {
		taskId: request.taskId,
		displaySummary: currentSummaryAtExit?.displaySummary ?? null,
		exitCode: event.exitCode,
		trustConfirmCount: exitEventData.trustConfirmCount,
	});

	stopWorkspaceTrustTimers(active);
	clearInterruptRecoveryTimer(active);

	const result = deps.applyTransitionEvent(currentEntry, {
		type: "process.exit",
		exitCode: event.exitCode,
		interrupted: wasInterrupted,
	});
	if (pendingInterruptSignal) {
		deps.onInterruptRecoveryApplied?.(request.taskId, pendingInterruptSignal, result, active.sessionInstanceId);
	}

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
	// Do not let the resume-failure handling below rewrite that explicit stop or
	// clear the exact resume identity needed by a later restore.
	const wasExplicitStop = !autoRestartDecision.restart && autoRestartDecision.reason === "suppressed";
	const resumeExitedBeforeInteractiveSession =
		!wasExplicitStop &&
		!request.startupRecoveryToken &&
		request.resumeConversation &&
		preExitState === "awaiting_review" &&
		(currentSummaryAtExit?.reviewReason === "attention" || currentSummaryAtExit?.reviewReason === "interrupted") &&
		event.exitCode != null &&
		currentEntry.launchMonitor?.outcome?.status === "exited" &&
		currentEntry.restartRequest?.kind === "task";

	if (autoRestartDecision.restart) {
		scheduleAutoRestart(
			currentEntry,
			{
				startTaskSession: (r) => deps.startTaskSession(r),
				updateStore: (id, patch) => deps.updateStore(id, patch),
				applyDenied: () => deps.applyTransitionEvent(currentEntry, { type: "autorestart.denied" }),
			},
			{ resumeSessionId: currentSummaryAtExit?.resumeSessionId },
		);
	} else if (resumeExitedBeforeInteractiveSession) {
		const resumeExitData = {
			taskId: request.taskId,
			agentId: request.agentId,
			exitCode: event.exitCode,
			preExitState,
			preExitReviewReason: currentSummaryAtExit.reviewReason,
			hasResumeSessionId: Boolean(request.resumeSessionId?.trim()),
		};
		if (event.exitCode === 0 && !request.startupRecoveryToken) {
			const message = "Resume exited before opening an interactive session; no replacement prompt was replayed.";
			sessionLog.warn("resume exited before interactive session; preserving failed resume", resumeExitData);
			const failedSummary =
				deps.applyTransitionEvent(currentEntry, {
					type: "resume.failed",
					clearResumeSessionId: false,
					warningMessage: message,
				})?.summary ?? deps.getSummary(request.taskId);
			writeSystemOutput(currentEntry, message, failedSummary);
		} else if (event.exitCode !== 0) {
			const failedStoredTargetedResume =
				(request.agentId === "codex" || request.agentId === "claude" || request.agentId === "pi") &&
				Boolean(request.resumeSessionId?.trim());
			const message = failedStoredTargetedResume
				? request.agentId === "claude"
					? STORED_CLAUDE_RESUME_FAILED_WARNING
					: request.agentId === "pi"
						? STORED_PI_RESUME_FAILED_WARNING
						: STORED_CODEX_RESUME_FAILED_WARNING
				: `Resume failed before opening an interactive session (exit code ${event.exitCode}).`;
			sessionLog.warn("resume exited before interactive session; preserving failed resume", {
				...resumeExitData,
				clearedResumeSessionId: failedStoredTargetedResume,
			});
			const failedSummary =
				deps.applyTransitionEvent(currentEntry, {
					type: "resume.failed",
					clearResumeSessionId: failedStoredTargetedResume,
					warningMessage: message,
				})?.summary ?? deps.getSummary(request.taskId);
			writeSystemOutput(currentEntry, message, failedSummary);
		}
	} else if (
		!wasExplicitStop &&
		exitSummary?.state === "awaiting_review" &&
		exitSummary.reviewReason === "interrupted"
	) {
		deps.applyTransitionEvent(currentEntry, { type: "autorestart.denied" });
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
	let sessionForCallbacks: PtySession | null = null;
	const terminalStateMirror = new TerminalStateMirror(cols, rows, {
		onInputResponse: (data) => {
			if (!sessionForCallbacks || entry.active?.session !== sessionForCallbacks || hasLiveOutputListener(entry)) {
				return;
			}
			sessionForCallbacks.write(data);
		},
	});
	const env = buildTerminalEnvironment(request.env);

	let session: PtySession;
	let callbacksReady = false;
	const preHandoffOutput: Buffer[] = [];
	let preHandoffExit: PtyExitEvent | null = null;
	const sessionInstanceId = randomUUID();
	const handleShellExit = (event: PtyExitEvent): void => {
		if (!sessionForCallbacks || entry.active?.session !== sessionForCallbacks) return;
		stopWorkspaceTrustTimers(entry.active);
		clearInterruptRecoveryTimer(entry.active);
		sessionLog.info("shell session process exited", {
			taskId: request.taskId,
			exitCode: event.exitCode,
		});

		const summary = deps.updateStore(request.taskId, {
			state: entry.active.session.wasInterrupted() ? "awaiting_review" : "idle",
			reviewReason: entry.active.session.wasInterrupted() ? "interrupted" : null,
			exitCode: event.exitCode,
			pid: null,
		});
		const cleanupFn = finalizeProcessExit(entry, summary, event.exitCode);
		if (cleanupFn) void cleanupFn().catch(() => {});
	};
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
			onData: (chunk) => {
				if (!callbacksReady) {
					preHandoffOutput.push(Buffer.from(chunk));
					return;
				}
				if (entry.active?.session !== sessionForCallbacks) return;
				processShellSessionOutput(entry, request.taskId, chunk);
			},
			onExit: (event) => {
				if (!callbacksReady) {
					preHandoffExit = event;
					return;
				}
				handleShellExit(event);
			},
		});
		sessionForCallbacks = session;
	} catch (error) {
		terminalStateMirror.dispose();
		deps.updateStore(request.taskId, {
			sessionInstanceId,
			launchOperationId: null,
			state: "awaiting_review",
			agentId: null,
			sessionLaunchPath: request.cwd,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: "error",
			exitCode: null,
			lastHookAt: null,
			lastProviderHookOccurredAt: null,
			recentProviderHookDeliveryIds: [],
			recentProviderHookOrderObservations: [],
			latestHookActivity: null,
			outstandingInteraction: null,
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
		lastProviderHookOccurredAt: null,
		recentProviderHookDeliveryIds: [],
		recentProviderHookOrderObservations: [],
		latestHookActivity: null,
		outstandingInteraction: null,
		stalledSince: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	});
	callbacksReady = true;
	if (entry.active?.session === sessionForCallbacks) {
		for (const chunk of preHandoffOutput) {
			processShellSessionOutput(entry, request.taskId, chunk);
		}
		if (preHandoffExit) handleShellExit(preHandoffExit);
	}

	return preHandoffExit ? deps.ensureEntry(request.taskId) : (summary ?? deps.ensureEntry(request.taskId));
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
			scheduleAutoRestart(
				entry,
				{
					startTaskSession: (r) => deps.startTaskSession(r),
					updateStore: (id, patch) => deps.updateStore(id, patch),
					applyDenied: () => deps.applyTransitionEvent(entry, { type: "autorestart.denied" }),
				},
				{ resumeSessionId: summary.resumeSessionId },
			);
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
	action:
		| "marked_interrupted"
		| "stale_pid_cleared"
		| "stale_recovery_requirement_cleared"
		| "legacy_semantic_state_uncertain";
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
				state: "awaiting_review",
				reviewReason: "interrupted",
				pid: null,
				stalledSince: null,
				latestHookActivity: null,
				outstandingInteraction: null,
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
		} else if (summary.startupRecoveryRequired === true && !requiresStartupRecovery) {
			// A prior runtime could persist a false attention classification with a
			// durable recovery handoff. Clear that obsolete process decision once
			// the shared semantic policy proves the task is not recoverable.
			deps.updateStore(taskId, {
				startupRecoveryRequired: false,
				startupRecoverySemanticStateUncertain: recoveryPolicy.semanticStateUncertain,
				warningMessage: uncertaintyWarning,
			});
			corrections.push({
				taskId,
				action: "stale_recovery_requirement_cleared",
				previousState: summary.state,
				previousReviewReason: summary.reviewReason,
				hadPersistedPid: false,
				requiresStartupRecovery: false,
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
