// Pure reconciliation check functions for detecting and correcting session state drift.
// Each check takes a session entry + timestamp and returns an action or null.
// The sweep in TerminalSessionManager applies the first non-null action per entry.
import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../core/api-contract";

export type ReconciliationAction = { type: "clear_hook_activity" } | { type: "recover_dead_process" };

/** Minimal shape of a session entry needed by the check functions. */
export interface ReconciliationEntry {
	summary: RuntimeTaskSessionSummary;
	active: unknown;
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

/** Ordered by priority: dead process > clear activity. */
export const reconciliationChecks: ReconciliationCheck[] = [checkDeadProcess, checkStaleHookActivity];
