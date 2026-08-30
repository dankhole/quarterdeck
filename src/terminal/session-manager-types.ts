// Shared types and helpers for session-manager and its extracted modules.
// These are internal to the terminal layer — external consumers should only
// import TerminalSessionManager from session-manager.ts.

import type { RuntimeTaskImage, RuntimeTaskSessionStopOutcome, RuntimeTaskSessionSummary } from "../core";
import type {
	AgentAdapterLaunchInput,
	AgentOutputTransitionDetector,
	AgentOutputTransitionInspectionPredicate,
} from "./agent-session-adapters";
import type { HookEventOrderState } from "./hook-event-order";
import { PtyLaunchError, PtySpawnError } from "./pty-runtime-health";
import type { PtySession } from "./pty-session";
import { markTaskSessionLaunchSuperseded, type TaskSessionLaunchMonitor } from "./session-launch-readiness";
import type { SessionResumeSemanticState } from "./session-startup-recovery-policy";
import type { TerminalProtocolFilterState } from "./terminal-protocol-filter";
import type { TerminalSessionListener } from "./terminal-session-service";
import type { TerminalStateMirror } from "./terminal-state-mirror";

// ── Session types ────────────────────────────────────────────────────────────

export interface NativeTaskSessionProfileEnvironment {
	CODEX_HOME?: string;
	CLAUDE_CONFIG_DIR?: string;
	HOME?: string;
}

export interface ActiveProcessState {
	session: PtySession;
	sessionInstanceId: string;
	launchOperationId: string | null;
	agentId: StartTaskSessionRequest["agentId"] | null;
	launchBinary: string | null;
	launchProfileEnvironment: NativeTaskSessionProfileEnvironment;
	claudeFullscreenEnabled: boolean;
	workspaceTrustBuffer: string | null;
	cols: number;
	baseRows: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	detectOutputTransition: AgentOutputTransitionDetector | null;
	shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | null;
	resetOutputTransitionDetection: (() => void) | null;
	autoConfirmedWorkspaceTrust: boolean;
	workspaceTrustConfirmCount: number;
	workspaceTrustConfirmTimer: NodeJS.Timeout | null;
	interruptRecoveryTimer: NodeJS.Timeout | null;
	interruptRecoveryStartedAt: number | null;
	interruptRecoverySignal: "ctrl_c" | "escape" | null;
}

export interface ProcessEntry {
	taskId: string;
	active: ActiveProcessState | null;
	terminalStateMirror: TerminalStateMirror | null;
	listenerIdCounter: number;
	listeners: Map<number, TerminalSessionListener>;
	restartRequest: RestartableSessionRequest | null;
	suppressAutoRestartOnExit: boolean;
	autoRestartTimestamps: number[];
	pendingAutoRestart: Promise<void> | null;
	/** True while startTaskSession is awaiting prepareAgentLaunch / PtySession.spawn. */
	pendingSessionStart: boolean;
	pendingSessionStartSince: number | null;
	pendingExitResolvers: Array<() => void>;
	hookCount: number;
	hookEventOrder: HookEventOrderState | null;
	/** Frozen launch boundary retained only for exact durable hook replay after process ownership is lost. */
	providerHookReplayBoundary: ProviderHookReplayBoundary | null;
	launchMonitor: TaskSessionLaunchMonitor | null;
	pendingStartupRecoveryToken: string | null;
}

export interface ProviderHookReplayBoundary {
	context: "startup" | "exited";
	sessionInstanceId: string;
	/** Legacy-only floor used when no provider-specific ordering history exists. */
	legacyOccurredAtFloor: number | null;
	/** Delivery ids already included in the durable summary. */
	recentDeliveryIds: ReadonlySet<string>;
	/** Natural-exit fence; startup crash recovery cannot know the prior process's exact close time. */
	closedAt: number | null;
}

export interface StartTaskSessionRequest {
	taskId: string;
	launchOperationId?: string;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	resumeConversation?: boolean;
	resumeSessionId?: string;
	awaitReview?: boolean;
	cols?: number;
	rows?: number;
	env?: Record<string, string | undefined>;
	projectId?: string;
	projectPath?: string;
	claudeFullscreenEnabled?: boolean;
	claudeLaunchPermissionMode?: AgentAdapterLaunchInput["claudeLaunchPermissionMode"];
	statuslineEnabled?: boolean;
	codexApprovalsReviewer?: AgentAdapterLaunchInput["codexApprovalsReviewer"];
	piToolApprovalsEnabled?: boolean;
	worktreeSystemPromptTemplate?: string;
	startupRecoveryToken?: string;
	/** Server-derived task meaning to preserve while replacing only the provider process. */
	resumeSemanticState?: SessionResumeSemanticState;
	/** True only when legacy persistence could not preserve the task's prior semantic state. */
	startupRecoverySemanticStateUncertain?: boolean;
	/** Retained when legacy persistence no longer contains enough information to classify the restored task. */
	startupRecoveryWarningMessage?: string;
}

export interface StartShellSessionRequest {
	taskId: string;
	cwd: string;
	cols?: number;
	rows?: number;
	binary: string;
	args?: string[];
	env?: Record<string, string | undefined>;
}

export type RestartableSessionRequest =
	| { kind: "task"; request: StartTaskSessionRequest }
	| { kind: "shell"; request: StartShellSessionRequest };

export interface StopTaskSessionResult {
	summary: RuntimeTaskSessionSummary | null;
	requestedSessionInstanceId: string | null;
	didExit: boolean;
	outcome: Exclude<RuntimeTaskSessionStopOutcome, "requested">;
	error?: string;
}

/** Server-only identity used to fence native/structured ownership handoffs. */
export interface NativeTaskSessionProcessIdentity {
	pid: number;
	sessionInstanceId: string;
	launchOperationId: string | null;
	agentId: StartTaskSessionRequest["agentId"] | null;
	binary: string | null;
	profileEnvironment: NativeTaskSessionProfileEnvironment;
}

export class TaskSessionStartCancelledError extends Error {
	readonly reason = "shutdown" as const;

	constructor() {
		super("Task session launch was cancelled because the terminal manager is shutting down.");
		this.name = "TaskSessionStartCancelledError";
	}
}

export function isTaskSessionStartCancelledError(error: unknown): error is TaskSessionStartCancelledError {
	return error instanceof TaskSessionStartCancelledError;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function cloneStartTaskSessionRequest(request: StartTaskSessionRequest): StartTaskSessionRequest {
	const resumeSemanticState = request.resumeSemanticState;
	return {
		...request,
		args: [...request.args],
		images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
		env: request.env ? { ...request.env } : undefined,
		resumeSemanticState: resumeSemanticState
			? resumeSemanticState.state === "awaiting_review"
				? {
						...resumeSemanticState,
						latestHookActivity: resumeSemanticState.latestHookActivity
							? { ...resumeSemanticState.latestHookActivity }
							: null,
						outstandingInteraction: resumeSemanticState.outstandingInteraction
							? { ...resumeSemanticState.outstandingInteraction }
							: null,
					}
				: {
						...resumeSemanticState,
						latestHookActivity: null,
					}
			: undefined,
	};
}

export function cloneStartShellSessionRequest(request: StartShellSessionRequest): StartShellSessionRequest {
	return {
		...request,
		args: request.args ? [...request.args] : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

/** Normalize optional cols/rows to safe integers with a fallback default. */
export function normalizeDimension(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? 0) : fallback;
}

/** Format a PTY spawn failure for display. */
export function formatSpawnFailure(binary: string, error: unknown, context: "task" | "shell"): string {
	const classified = error instanceof PtyLaunchError ? error : new PtySpawnError(error);
	const subject = context === "task" ? "task terminal" : "shell terminal";
	return `Failed to launch ${subject} "${binary}". ${classified.message}`;
}

export function buildTerminalEnvironment(
	...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
	return {
		...process.env,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "quarterdeck",
	};
}

export function createProcessEntry(taskId: string): ProcessEntry {
	return {
		taskId,
		active: null,
		terminalStateMirror: null,
		listenerIdCounter: 1,
		listeners: new Map(),
		restartRequest: null,
		suppressAutoRestartOnExit: false,
		autoRestartTimestamps: [],
		pendingAutoRestart: null,
		pendingSessionStart: false,
		pendingSessionStartSince: null,
		pendingExitResolvers: [],
		hookCount: 0,
		hookEventOrder: null,
		providerHookReplayBoundary: null,
		launchMonitor: null,
		pendingStartupRecoveryToken: null,
	};
}

export const DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER = 3;

export interface EffectiveTerminalRowPolicy {
	claudeFullscreenEnabled?: boolean;
}

export function resolveEffectiveTerminalRowMultiplier(
	agentId: StartTaskSessionRequest["agentId"] | null,
	hasBrowserOutputListener: boolean,
	policy: EffectiveTerminalRowPolicy = {},
): number {
	if (hasBrowserOutputListener || agentId !== "claude" || policy.claudeFullscreenEnabled === true) {
		return 1;
	}
	return DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER;
}

export function resolveEffectiveTerminalRows(
	agentId: StartTaskSessionRequest["agentId"] | null,
	baseRows: number,
	hasBrowserOutputListener: boolean,
	policy: EffectiveTerminalRowPolicy = {},
): number {
	return (
		Math.max(1, Math.floor(baseRows)) *
		resolveEffectiveTerminalRowMultiplier(agentId, hasBrowserOutputListener, policy)
	);
}

/** Check whether any listener has an output handler attached. */
export function hasLiveOutputListener(entry: ProcessEntry): boolean {
	for (const listener of entry.listeners.values()) {
		if (listener.onOutput) {
			return true;
		}
	}
	return false;
}

// ── ActiveProcessState factory ───────────────────────────────────────────────

import type { PreparedAgentLaunch } from "./agent-session-adapters";
import { createTerminalProtocolFilterState } from "./terminal-protocol-filter";

export interface CreateActiveProcessStateOptions {
	session: PtySession;
	sessionInstanceId: string;
	launchOperationId?: string | null;
	agentId: StartTaskSessionRequest["agentId"] | null;
	launchBinary?: string | null;
	launchProfileEnvironment?: NativeTaskSessionProfileEnvironment;
	claudeFullscreenEnabled?: boolean;
	cols: number;
	baseRows: number;
	rows: number;
	willAutoTrust: boolean;
	launch?: PreparedAgentLaunch;
}

export function createActiveProcessState(opts: CreateActiveProcessStateOptions): ActiveProcessState {
	return {
		session: opts.session,
		sessionInstanceId: opts.sessionInstanceId,
		launchOperationId: opts.launchOperationId ?? null,
		agentId: opts.agentId,
		launchBinary: opts.launchBinary ?? null,
		launchProfileEnvironment: { ...opts.launchProfileEnvironment },
		claudeFullscreenEnabled: opts.agentId === "claude" && opts.claudeFullscreenEnabled === true,
		workspaceTrustBuffer: opts.willAutoTrust ? "" : null,
		cols: opts.cols,
		baseRows: opts.baseRows,
		rows: opts.rows,
		terminalProtocolFilter: createTerminalProtocolFilterState({
			interceptOscColorQueries: true,
			suppressDeviceAttributeQueries: false,
		}),
		onSessionCleanup: opts.launch?.cleanup ?? null,
		detectOutputTransition: opts.launch?.detectOutputTransition ?? null,
		shouldInspectOutputForTransition: opts.launch?.shouldInspectOutputForTransition ?? null,
		resetOutputTransitionDetection: opts.launch?.resetOutputTransitionDetection ?? null,
		autoConfirmedWorkspaceTrust: false,
		workspaceTrustConfirmCount: 0,
		workspaceTrustConfirmTimer: null,
		interruptRecoveryTimer: null,
		interruptRecoveryStartedAt: null,
		interruptRecoverySignal: null,
	};
}

// ── Teardown helpers ─────────────────────────────────────────────────────────

import { stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import { clearInterruptRecoveryTimer } from "./session-interrupt-recovery";
import { cloneSummary } from "./session-summary-store";

/** Stop timers and kill the PTY for an active session. Nulls out entry.active and disposes the mirror. */
export function teardownActiveSession(entry: ProcessEntry): void {
	markTaskSessionLaunchSuperseded(entry.launchMonitor);
	if (entry.active) {
		stopWorkspaceTrustTimers(entry.active);
		clearInterruptRecoveryTimer(entry.active);
		entry.active.session.stop();
		entry.active = null;
	}
	entry.terminalStateMirror?.dispose();
	entry.terminalStateMirror = null;
	entry.hookEventOrder = null;
	entry.providerHookReplayBoundary = null;
}

/**
 * Shared exit-cleanup sequence: notify listeners, extract cleanup fn, null active,
 * resolve exit promises. Timer cleanup is the caller's responsibility since each
 * call site handles timers at different points in its flow.
 */
export function finalizeProcessExit(
	entry: ProcessEntry,
	summary: RuntimeTaskSessionSummary | null,
	exitCode: number | null,
): (() => Promise<void>) | null {
	for (const listener of entry.listeners.values()) {
		if (summary) {
			listener.onState?.(cloneSummary(summary));
		}
		listener.onExit?.(exitCode);
	}

	const cleanupFn = entry.active?.onSessionCleanup ?? null;
	if (entry.active) {
		entry.active.onSessionCleanup = null;
	}
	entry.active = null;
	// Natural exits retain one exact launch-scoped ordering window for the
	// durable hook outbox. Explicit teardown paths clear the boundary first.
	if (!entry.providerHookReplayBoundary) entry.hookEventOrder = null;

	for (const resolve of entry.pendingExitResolvers) {
		resolve();
	}
	entry.pendingExitResolvers = [];

	return cleanupFn;
}
