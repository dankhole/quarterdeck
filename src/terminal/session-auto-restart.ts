// Auto-restart logic for agent sessions that exit unexpectedly.
// Extracted from session-manager.ts — determines whether a session should
// auto-restart after exit and executes the restart with rate limiting.

import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { emitSessionEvent } from "../core/event-log";
import type { ProcessEntry, StartTaskSessionRequest } from "./session-manager-types";
import { cloneStartTaskSessionRequest } from "./session-manager-types";
import { cloneSummary } from "./session-summary-store";

export const AUTO_RESTART_WINDOW_MS = 5_000;
export const MAX_AUTO_RESTARTS_PER_WINDOW = 3;

export type AutoRestartDecision =
	| { restart: true }
	| { restart: false; reason: "suppressed" | "no_listeners" | "rate_limited" };

/**
 * Determines if auto-restart should proceed after process exit.
 * Mutates `entry.suppressAutoRestartOnExit` and `entry.autoRestartTimestamps`
 * as side effects (matching original behavior).
 */
export function shouldAutoRestart(entry: ProcessEntry): AutoRestartDecision {
	const wasSuppressed = entry.suppressAutoRestartOnExit;
	entry.suppressAutoRestartOnExit = false;
	if (wasSuppressed) {
		return { restart: false, reason: "suppressed" };
	}
	if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
		return { restart: false, reason: "no_listeners" };
	}
	const currentTime = Date.now();
	entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
		(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
	);
	if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
		emitSessionEvent(entry.taskId, "autorestart.rate_limited", {
			timestamps: entry.autoRestartTimestamps,
		});
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

/**
 * Schedule an async auto-restart for a task session. Guards against duplicate
 * restarts via `entry.pendingAutoRestart`. On failure, surfaces the error as
 * a warning message and terminal output to listeners.
 */
export function scheduleAutoRestart(entry: ProcessEntry, callbacks: AutoRestartCallbacks): void {
	if (entry.pendingAutoRestart) {
		return;
	}
	const restartRequest = entry.restartRequest;
	if (!restartRequest || restartRequest.kind !== "task") {
		return;
	}
	emitSessionEvent(entry.taskId, "autorestart.triggered", {
		restartCount: entry.autoRestartTimestamps.length,
	});
	let pendingAutoRestart: Promise<void> | null = null;
	pendingAutoRestart = (async () => {
		try {
			const request = cloneStartTaskSessionRequest(restartRequest.request);
			// Resume conversation so the agent has context. awaitReview=true
			// because --continue opens the prompt — it doesn't resume active work.
			// If --continue fails, fall back to a fresh start (still in review).
			request.resumeConversation = true;
			request.awaitReview = true;
			try {
				await callbacks.startTaskSession(request);
			} catch {
				emitSessionEvent(entry.taskId, "autorestart.continue_failed", {});
				request.resumeConversation = false;
				await callbacks.startTaskSession(request);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			emitSessionEvent(entry.taskId, "autorestart.failed", {
				error: message,
			});
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
