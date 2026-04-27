// Auto-restart logic for agent sessions that exit unexpectedly.
// Extracted from session-manager.ts — determines whether a session should
// auto-restart after exit and executes the restart with rate limiting.
//
// Auto-restart exists for ONE purpose: recovering from unexpected agent
// crashes that happen while the agent is actively working (state "running").
// When an agent finishes a task, it sends a to_review hook (transitioning
// to "awaiting_review") and then its process exits — that exit is normal
// lifecycle cleanup, NOT a crash. The pre-exit state distinguishes the two:
//
//   running → process exits     = crash mid-work → auto-restart
//   awaiting_review → exits     = normal cleanup after handoff → no restart
//   interrupted → exits         = user-initiated stop → no restart

import type { RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "../core";
import type { ProcessEntry, StartTaskSessionRequest } from "./session-manager-types";
import { cloneStartTaskSessionRequest } from "./session-manager-types";
import { cloneSummary } from "./session-summary-store";

export const AUTO_RESTART_WINDOW_MS = 5_000;
export const MAX_AUTO_RESTARTS_PER_WINDOW = 3;

export type AutoRestartDecision =
	| { restart: true }
	| { restart: false; reason: "suppressed" | "no_listeners" | "rate_limited" | "not_running" };

/**
 * Determines if auto-restart should proceed after process exit.
 *
 * `preExitState` is the session state captured BEFORE the process.exit event
 * is applied to the state machine. This is critical because the state machine
 * unconditionally overwrites the state on exit (e.g., awaiting_review/hook
 * becomes awaiting_review/error), losing the information about whether the
 * agent was actively working when it died.
 *
 * Mutates `entry.suppressAutoRestartOnExit` and `entry.autoRestartTimestamps`
 * as side effects (matching original behavior).
 */
export function shouldAutoRestart(entry: ProcessEntry, preExitState: RuntimeTaskSessionState): AutoRestartDecision {
	const wasSuppressed = entry.suppressAutoRestartOnExit;
	entry.suppressAutoRestartOnExit = false;
	if (wasSuppressed) {
		return { restart: false, reason: "suppressed" };
	}
	// Only restart when the agent was actively working. Any other pre-exit
	// state means the agent already handed off (hook/exit/error/stalled) or
	// was stopped by the user (interrupted). The process exiting in those
	// states is normal cleanup, not a crash.
	if (preExitState !== "running") {
		return { restart: false, reason: "not_running" };
	}
	if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
		return { restart: false, reason: "no_listeners" };
	}
	const currentTime = Date.now();
	entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
		(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
	);
	if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
		return { restart: false, reason: "rate_limited" };
	}
	entry.autoRestartTimestamps.push(currentTime);
	return { restart: true };
}

export interface AutoRestartCallbacks {
	startTaskSession: (request: StartTaskSessionRequest) => Promise<RuntimeTaskSessionSummary>;
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
	applyDenied: () => void;
}

export interface ScheduleAutoRestartOptions {
	skipContinueAttempt?: boolean;
}

/**
 * Schedule an async auto-restart for a task session. Guards against duplicate
 * restarts via `entry.pendingAutoRestart`. On failure, surfaces the error as
 * a warning message and terminal output to listeners.
 *
 * When `skipContinueAttempt` is true, the restart goes straight to a fresh
 * session without `--continue`. Used when `--continue` already failed at the
 * process level (e.g. server-restart resume where the conversation no longer
 * exists).
 */
export function scheduleAutoRestart(
	entry: ProcessEntry,
	callbacks: AutoRestartCallbacks,
	options?: ScheduleAutoRestartOptions,
): void {
	if (entry.pendingAutoRestart) {
		return;
	}
	const restartRequest = entry.restartRequest;
	if (!restartRequest || restartRequest.kind !== "task") {
		return;
	}
	let pendingAutoRestart: Promise<void> | null = null;
	pendingAutoRestart = (async () => {
		try {
			const request = cloneStartTaskSessionRequest(restartRequest.request);
			// Resume conversation so the agent has context. awaitReview=true
			// because --continue opens the prompt — it doesn't resume active work.
			// If --continue fails, fall back to a fresh start (still in review).
			request.resumeConversation = !options?.skipContinueAttempt;
			request.awaitReview = true;
			if (options?.skipContinueAttempt) {
				await callbacks.startTaskSession(request);
			} else {
				try {
					await callbacks.startTaskSession(request);
				} catch {
					request.resumeConversation = false;
					await callbacks.startTaskSession(request);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Transition to review immediately instead of waiting for the
			// reconciliation sweep to catch the orphaned interrupted state.
			callbacks.applyDenied();
			const summary = callbacks.updateStore(entry.taskId, {
				warningMessage: message,
			});
			const output = Buffer.from(`\r\n[quarterdeck] ${message}\r\n`, "utf8");
			for (const listener of entry.listeners.values()) {
				listener.onOutput?.(output);
				if (summary) {
					listener.onState?.(cloneSummary(summary));
				}
			}
		} finally {
			if (entry.pendingAutoRestart === pendingAutoRestart) {
				entry.pendingAutoRestart = null;
			}
		}
	})();
	entry.pendingAutoRestart = pendingAutoRestart;
}
