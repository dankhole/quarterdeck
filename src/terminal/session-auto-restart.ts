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

/**
 * Determines if auto-restart should proceed after process exit.
 * Mutates `entry.suppressAutoRestartOnExit` and `entry.autoRestartTimestamps`
 * as side effects (matching original behavior).
 */
export function shouldAutoRestart(entry: ProcessEntry): boolean {
	const wasSuppressed = entry.suppressAutoRestartOnExit;
	entry.suppressAutoRestartOnExit = false;
	if (wasSuppressed) {
		return false;
	}
	if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
		return false;
	}
	const currentTime = Date.now();
	entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
		(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
	);
	if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
		emitSessionEvent(entry.taskId, "autorestart.rate_limited", {
			timestamps: entry.autoRestartTimestamps,
		});
		return false;
	}
	entry.autoRestartTimestamps.push(currentTime);
	return true;
}

export interface AutoRestartCallbacks {
	startTaskSession: (request: StartTaskSessionRequest) => Promise<RuntimeTaskSessionSummary>;
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
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
			// Don't carry resumeConversation into auto-restarts. If the original
			// --continue attempt failed (e.g. "No conversation found"), retrying
			// with --continue would just fail again. Start a fresh session instead.
			request.resumeConversation = false;
			request.awaitReview = false;
			await callbacks.startTaskSession(request);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			emitSessionEvent(entry.taskId, "autorestart.failed", {
				error: message,
			});
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
