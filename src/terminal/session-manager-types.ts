// Shared types and helpers for session-manager and its extracted modules.
// These are internal to the terminal layer — external consumers should only
// import TerminalSessionManager from session-manager.ts.

import type { RuntimeTaskImage, RuntimeTaskSessionSummary } from "../core";
import type {
	AgentAdapterLaunchInput,
	AgentOutputTransitionDetector,
	AgentOutputTransitionInspectionPredicate,
} from "./agent-session-adapters";
import type { PtySession } from "./pty-session";
import type { TerminalProtocolFilterState } from "./terminal-protocol-filter";
import type { TerminalSessionListener } from "./terminal-session-service";
import type { TerminalStateMirror } from "./terminal-state-mirror";

// ── Session types ────────────────────────────────────────────────────────────

export interface ActiveProcessState {
	session: PtySession;
	workspaceTrustBuffer: string | null;
	cols: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	deferredStartupInput: string | null;
	detectOutputTransition: AgentOutputTransitionDetector | null;
	shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | null;
	awaitingCodexPromptAfterEnter: boolean;
	autoConfirmedWorkspaceTrust: boolean;
	workspaceTrustConfirmCount: number;
	workspaceTrustConfirmTimer: NodeJS.Timeout | null;
	interruptRecoveryTimer: NodeJS.Timeout | null;
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
	pendingExitResolvers: Array<() => void>;
	hookCount: number;
}

export interface StartTaskSessionRequest {
	taskId: string;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeConversation?: boolean;
	awaitReview?: boolean;
	cols?: number;
	rows?: number;
	env?: Record<string, string | undefined>;
	projectId?: string;
	projectPath?: string;
	statuslineEnabled?: boolean;
	worktreeAddParentGitDir?: boolean;
	worktreeAddQuarterdeckDir?: boolean;
	worktreeSystemPromptTemplate?: string;
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

// ── Helpers ──────────────────────────────────────────────────────────────────

export function cloneStartTaskSessionRequest(request: StartTaskSessionRequest): StartTaskSessionRequest {
	return {
		...request,
		args: [...request.args],
		images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
		env: request.env ? { ...request.env } : undefined,
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
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return context === "task"
			? `Failed to launch "${binary}". Command not found. Install a supported agent CLI and select it in Settings.`
			: `Failed to launch "${binary}". Command not found on this system.`;
	}
	return `Failed to launch "${binary}": ${message}`;
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
		pendingExitResolvers: [],
		hookCount: 0,
	};
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

export function hasCodexInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	return /(?:^|[\n\r])\s*›\s*/u.test(stripped);
}

export function hasCodexStartupUiRendered(text: string): boolean {
	const stripped = stripAnsi(text).toLowerCase();
	return stripped.includes("openai codex (v");
}

// Inline import to avoid circular deps — stripAnsi is a leaf utility.
import { stripAnsi } from "./output-utils";

// ── ActiveProcessState factory ───────────────────────────────────────────────

import type { PreparedAgentLaunch } from "./agent-session-adapters";
import { createTerminalProtocolFilterState } from "./terminal-protocol-filter";

export interface CreateActiveProcessStateOptions {
	session: PtySession;
	cols: number;
	rows: number;
	willAutoTrust: boolean;
	launch?: PreparedAgentLaunch;
}

export function createActiveProcessState(opts: CreateActiveProcessStateOptions): ActiveProcessState {
	return {
		session: opts.session,
		workspaceTrustBuffer: opts.willAutoTrust ? "" : null,
		cols: opts.cols,
		rows: opts.rows,
		terminalProtocolFilter: createTerminalProtocolFilterState({
			interceptOscColorQueries: true,
			suppressDeviceAttributeQueries: false,
		}),
		onSessionCleanup: opts.launch?.cleanup ?? null,
		deferredStartupInput: opts.launch?.deferredStartupInput ?? null,
		detectOutputTransition: opts.launch?.detectOutputTransition ?? null,
		shouldInspectOutputForTransition: opts.launch?.shouldInspectOutputForTransition ?? null,
		awaitingCodexPromptAfterEnter: false,
		autoConfirmedWorkspaceTrust: false,
		workspaceTrustConfirmCount: 0,
		workspaceTrustConfirmTimer: null,
		interruptRecoveryTimer: null,
	};
}

// ── Teardown helpers ─────────────────────────────────────────────────────────

import { stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import { clearInterruptRecoveryTimer } from "./session-interrupt-recovery";
import { cloneSummary } from "./session-summary-store";

/** Stop timers and kill the PTY for an active session. Nulls out entry.active and disposes the mirror. */
export function teardownActiveSession(entry: ProcessEntry): void {
	if (entry.active) {
		stopWorkspaceTrustTimers(entry.active);
		clearInterruptRecoveryTimer(entry.active);
		entry.active.session.stop();
		entry.active = null;
	}
	entry.terminalStateMirror?.dispose();
	entry.terminalStateMirror = null;
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

	for (const resolve of entry.pendingExitResolvers) {
		resolve();
	}
	entry.pendingExitResolvers = [];

	return cleanupFn;
}
