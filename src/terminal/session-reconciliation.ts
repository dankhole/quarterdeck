// Pure reconciliation check functions for detecting and correcting task-session drift.
// Each check takes a session entry + timestamp and returns an action or null.
// The sweep in TerminalSessionManager applies the first non-null action per entry.
//
// ADDING NEW CHECKS: When adding dynamic UI state or session-dependent features,
// put only live session/process drift checks here. Stale lock artifacts, orphan
// worktrees, orphan agent processes, and dangling persisted-state references
// belong to the project orphan-maintenance/startup-shutdown cleanup paths.
// Currently covers:
//   - Dead task processes (PID no longer exists)
//   - Processless active task sessions (state says running, no PTY)
//   - Interrupted task sessions with no pending auto-restart (failed or denied)
//   - Stale task hook activity metadata
// Future candidates: auto-restart loop breaking, frontend panel state reconciliation.
import { isPermissionActivity, type RuntimeTaskSessionSummary } from "../core";
import { isProcessAlive } from "./process-liveness";

export { isPermissionActivity } from "../core";
export { isProcessAlive } from "./process-liveness";

export type ReconciliationAction =
	| { type: "clear_hook_activity" }
	| { type: "recover_dead_process" }
	| { type: "mark_processless_error" }
	| { type: "move_interrupted_to_review" };

/** Minimal shape of a session entry needed by the check functions. */
export interface ReconciliationEntry {
	summary: RuntimeTaskSessionSummary;
	active: unknown;
	restartRequest: unknown;
	pendingAutoRestart: unknown;
	pendingSessionStart: boolean;
}

export type ReconciliationCheck = (entry: ReconciliationEntry, nowMs: number) => ReconciliationAction | null;

/**
 * Detects dead processes in any active state (running or awaiting_review).
 * Extends the former stale process watchdog to also cover awaiting_review.
 */
export function checkDeadProcess(entry: ReconciliationEntry, _nowMs: number): ReconciliationAction | null {
	const { summary } = entry;
	if (summary.state !== "running" && summary.state !== "awaiting_review") {
		return null;
	}
	if (!entry.active) {
		return null;
	}
	if (summary.pid == null) {
		return null;
	}
	if (isProcessAlive(summary.pid)) {
		return null;
	}
	return { type: "recover_dead_process" };
}

/**
 * Detects stale `latestHookActivity` on sessions that have transitioned away
 * from the state that set it.
 */
export function checkStaleHookActivity(entry: ReconciliationEntry, _nowMs: number): ReconciliationAction | null {
	const { summary } = entry;
	if (!summary.latestHookActivity) {
		return null;
	}
	const hasPermission = isPermissionActivity(summary.latestHookActivity);

	// Stale permission context on a running card
	if (summary.state === "running" && hasPermission) {
		return { type: "clear_hook_activity" };
	}

	if (summary.state === "awaiting_review") {
		// Permission badge on a non-hook review (e.g., attention after Escape, exit, error)
		if (summary.reviewReason !== "hook" && hasPermission) {
			return { type: "clear_hook_activity" };
		}
	}

	return null;
}

/**
 * Detects sessions in an active state (running or awaiting_review) that have
 * lost their process handle without going through the normal onExit path's
 * auto-restart logic — typically because no WebSocket listeners were attached
 * when the process exited. Only fires for sessions that were launched this
 * server lifetime (restartRequest is set) and aren't already being restarted.
 *
 * Does NOT auto-restart — that happens in recoverStaleSession when a viewer
 * reconnects. This check just ensures the card shows "Error" instead of a
 * stale "Ready for review" or "Running" status.
 */
export function checkProcesslessActiveSession(entry: ReconciliationEntry, _nowMs: number): ReconciliationAction | null {
	const { summary } = entry;
	if (summary.state !== "running" && summary.state !== "awaiting_review") {
		return null;
	}
	if (entry.active) {
		return null;
	}
	if (!entry.restartRequest) {
		return null;
	}
	if (entry.pendingAutoRestart || entry.pendingSessionStart) {
		return null;
	}
	// A processless awaiting_review session is expected — the agent finished
	// its work or was stopped, then the backing process exited as normal
	// cleanup. The review reason was already set correctly by the onExit
	// handler or hook. Only flag "running" sessions as processless errors,
	// since those genuinely lost their process mid-work.
	if (summary.state === "awaiting_review") {
		return null;
	}
	return { type: "mark_processless_error" };
}

/**
 * Safety net for interrupted sessions where auto-restart was attempted but
 * failed (pendingAutoRestart cleared in finally block), or where the onExit
 * autorestart.denied transition was missed for any reason. Moves the session
 * to awaiting_review so the card lands in review for the user to decide.
 *
 * Only applies to sessions started this server lifetime (restartRequest is set).
 * Hydrated-from-disk sessions have restartRequest=null and are waiting for
 * resumeInterruptedSessions on first UI connection — the sweep must not
 * prematurely move them to awaiting_review or the resume filter won't match.
 */
export function checkInterruptedNoRestart(entry: ReconciliationEntry, _nowMs: number): ReconciliationAction | null {
	const { summary } = entry;
	if (summary.state !== "interrupted") {
		return null;
	}
	if (entry.pendingAutoRestart) {
		return null;
	}
	// Sessions hydrated from disk after a server restart don't have a
	// restartRequest. Leave them in "interrupted" for resumeInterruptedSessions.
	if (!entry.restartRequest) {
		return null;
	}
	return { type: "move_interrupted_to_review" };
}

/** Ordered by priority: dead process > processless recovery > interrupted cleanup > clear activity. */
export const reconciliationChecks: ReconciliationCheck[] = [
	checkDeadProcess,
	checkProcesslessActiveSession,
	checkInterruptedNoRestart,
	checkStaleHookActivity,
];
