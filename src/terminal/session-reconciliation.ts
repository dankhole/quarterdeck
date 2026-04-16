// Pure reconciliation check functions for detecting and correcting session state drift.
// Each check takes a session entry + timestamp and returns an action or null.
// The sweep in TerminalSessionManager applies the first non-null action per entry.
//
// ADDING NEW CHECKS: When adding dynamic UI state or session-dependent features,
// consider whether stale/orphaned state needs cleanup here. Currently covers:
//   - Dead processes (PID no longer exists)
//   - Processless active sessions (state says running, no PTY)
//   - Interrupted sessions with no pending auto-restart (failed or denied)
//   - Stale hook activity metadata
//   - Stalled sessions (running but no activity for several minutes)
// Future candidates: auto-restart loop breaking, frontend panel state reconciliation.
import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../core/api-contract";

export type ReconciliationAction =
	| { type: "clear_hook_activity" }
	| { type: "recover_dead_process" }
	| { type: "mark_processless_error" }
	| { type: "mark_stalled" }
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

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		// EPERM means the process exists but we lack permission — it's alive.
		// ESRCH means no such process — it's dead.
		// This distinction matters on Windows where access-denied is common.
		if (typeof error === "object" && error !== null && "code" in error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		}
		return false;
	}
}

/**
 * Returns true when the hook activity contains permission-related fields.
 * Mirrors the UI's `isPermissionRequest()` in `web-ui/src/utils/session-status.ts`.
 * Both functions must stay in sync — a future refactor should extract a shared utility.
 */
export function isPermissionActivity(activity: RuntimeTaskHookActivity): boolean {
	const hook = activity.hookEventName?.toLowerCase() ?? "";
	const notif = activity.notificationType?.toLowerCase() ?? "";
	const text = activity.activityText?.toLowerCase() ?? "";
	return (
		hook === "permissionrequest" ||
		notif === "permission_prompt" ||
		notif === "permission.asked" ||
		text === "waiting for approval"
	);
}

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
	// its work (or was stopped/stalled), then the backing process exited as
	// normal cleanup. The review reason was already set correctly by the
	// onExit handler or hook. Only flag "running" sessions as processless
	// errors, since those genuinely lost their process mid-work.
	if (summary.state === "awaiting_review") {
		return null;
	}
	return { type: "mark_processless_error" };
}

/** How long (ms) a running session can go without activity before being marked stalled. */
export const STALLED_HOOK_THRESHOLD_MS = 180_000;

/**
 * Detects running sessions that haven't shown activity in over 3 minutes.
 * Uses the more recent of lastHookAt and lastOutputAt as the activity reference —
 * terminal output isn't as authoritative as hooks but does indicate the process
 * is alive and producing something, so it suppresses premature stalled warnings.
 * Only fires after at least one hook has been received (lastHookAt is set),
 * so fresh sessions in their initial thinking phase aren't flagged.
 * Sets stalledSince once; subsequent sweeps skip already-stalled sessions.
 */
export function checkStalledSession(entry: ReconciliationEntry, nowMs: number): ReconciliationAction | null {
	const { summary } = entry;
	if (summary.state !== "running") {
		return null;
	}
	if (summary.lastHookAt == null) {
		return null;
	}
	if (summary.stalledSince != null) {
		return null;
	}
	const lastActivity = Math.max(summary.lastHookAt, summary.lastOutputAt ?? 0);
	if (nowMs - lastActivity > STALLED_HOOK_THRESHOLD_MS) {
		return { type: "mark_stalled" };
	}
	return null;
}

/**
 * Safety net for interrupted sessions where auto-restart was attempted but
 * failed (pendingAutoRestart cleared in finally block), or where the onExit
 * autorestart.denied transition was missed for any reason. Moves the session
 * to awaiting_review so the card lands in review for the user to decide.
 */
export function checkInterruptedNoRestart(entry: ReconciliationEntry, _nowMs: number): ReconciliationAction | null {
	const { summary } = entry;
	if (summary.state !== "interrupted") {
		return null;
	}
	if (entry.pendingAutoRestart) {
		return null;
	}
	return { type: "move_interrupted_to_review" };
}

/** Ordered by priority: dead process > processless recovery > interrupted cleanup > clear activity > stalled. */
export const reconciliationChecks: ReconciliationCheck[] = [
	checkDeadProcess,
	checkProcesslessActiveSession,
	checkInterruptedNoRestart,
	checkStaleHookActivity,
	checkStalledSession,
];
