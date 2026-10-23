// Reconciliation sweep orchestration — runs the periodic check loop and applies
// corrective actions. The individual check functions live in session-reconciliation.ts;
// this module owns the timer lifecycle and action execution.

import type { RuntimeTaskSessionSummary } from "../core";
import { createTaggedLogger } from "../core";
import { stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import { clearInterruptRecoveryTimer } from "./session-interrupt-recovery";
import { probeSessionLaunchPaths } from "./session-launch-path-probe";
import type { ProcessEntry } from "./session-manager-types";
import { finalizeProcessExit } from "./session-manager-types";
import { type ReconciliationAction, reconciliationChecks } from "./session-reconciliation";
import type { SessionSummaryStore, SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";

const sessionLog = createTaggedLogger("session-reconciliation");

export const SESSION_RECONCILIATION_INTERVAL_MS = 10_000;
export const MISSING_SESSION_LAUNCH_PATH_WARNING =
	"The session launch folder no longer exists. Quarterdeck stopped the agent to prevent work in an invalid checkout. Restore the task or recreate the folder, then restart.";

export interface ReconciliationSweepContext {
	entries: Map<string, ProcessEntry>;
	store: SessionSummaryStore;
	applyTransitionEvent: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
	recoverMissingLaunchPath: (entry: ProcessEntry, warningMessage: string) => RuntimeTaskSessionSummary | null;
}

/** Run one reconciliation sweep, fencing path results to the captured launch. */
export async function reconcileSessionStates(
	ctx: ReconciliationSweepContext,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	const launches = new Map<ProcessEntry, { active: NonNullable<ProcessEntry["active"]>; sessionLaunchPath: string }>();
	for (const entry of ctx.entries.values()) {
		try {
			const summary = ctx.store.getSummary(entry.taskId);
			if (
				summary &&
				(summary.state === "running" || summary.state === "awaiting_review") &&
				summary.sessionLaunchPath &&
				entry.active
			) {
				launches.set(entry, { active: entry.active, sessionLaunchPath: summary.sessionLaunchPath });
			}
		} catch {
			// The main evaluation loop reports failed summary reads once per entry.
		}
	}
	const pathResults = launches.size
		? await probeSessionLaunchPaths([...launches.values()].map((launch) => launch.sessionLaunchPath))
		: new Map<string, boolean | null>();
	if (!isCurrent()) return;

	const nowMs = Date.now();
	for (const entry of ctx.entries.values()) {
		if (!isCurrent()) return;
		try {
			const summary = ctx.store.getSummary(entry.taskId);
			if (!summary || (summary.state !== "running" && summary.state !== "awaiting_review")) {
				continue;
			}

			// Keying captured launches by entry object fences replacement entries.
			const launch = launches.get(entry);
			const sessionLaunchPathExists =
				launch && entry.active === launch.active && summary.sessionLaunchPath === launch.sessionLaunchPath
					? (pathResults.get(launch.sessionLaunchPath) ?? null)
					: null;
			for (const check of reconciliationChecks) {
				const action = check(
					{
						summary,
						active: entry.active,
						restartRequest: entry.restartRequest,
						pendingAutoRestart: entry.pendingAutoRestart,
						pendingSessionStart: entry.pendingSessionStart,
						pendingStartupRecoveryToken: entry.pendingStartupRecoveryToken,
						suppressAutoRestartOnExit: entry.suppressAutoRestartOnExit,
						sessionLaunchPathExists,
					},
					nowMs,
				);
				if (action) {
					if (!isCurrent()) return;
					if (ctx.entries.get(entry.taskId) !== entry) break;
					applyReconciliationAction(entry, action, ctx);
					break;
				}
			}
		} catch (err) {
			sessionLog.error(`Reconciliation error for ${entry.taskId}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/** Apply a single reconciliation action to an entry. */
export function applyReconciliationAction(
	entry: ProcessEntry,
	action: ReconciliationAction,
	ctx: ReconciliationSweepContext,
): void {
	switch (action.type) {
		case "recover_dead_process": {
			if (!entry.active) break;
			stopWorkspaceTrustTimers(entry.active);
			clearInterruptRecoveryTimer(entry.active);
			const result = ctx.applyTransitionEvent(entry, {
				type: "process.exit",
				exitCode: null,
				interrupted: false,
			});
			const summary = result?.summary ?? ctx.store.getSummary(entry.taskId);
			const cleanupFn = finalizeProcessExit(entry, summary, null);
			if (cleanupFn) {
				cleanupFn().catch(() => {});
			}
			break;
		}
		case "recover_missing_launch_path": {
			if (!entry.active) break;
			ctx.recoverMissingLaunchPath(entry, MISSING_SESSION_LAUNCH_PATH_WARNING);
			break;
		}
		case "mark_processless_error": {
			// Route through the state machine instead of directly mutating the
			// store. process.exit with exitCode=null maps to reviewReason="error",
			// which is the same outcome but validated by the reducer.
			ctx.applyTransitionEvent(entry, {
				type: "process.exit",
				exitCode: null,
				interrupted: false,
			});
			break;
		}
		case "clear_hook_activity": {
			ctx.store.update(entry.taskId, { latestHookActivity: null });
			break;
		}
	}
}

export interface ReconciliationTimer {
	start(): void;
	stop(): void;
}

/** Creates and manages the periodic reconciliation interval timer. */
export function createReconciliationTimer(ctx: ReconciliationSweepContext): ReconciliationTimer {
	let timer: NodeJS.Timeout | null = null;
	let generation = 0;
	let inFlight = false;

	return {
		start() {
			if (timer) {
				return;
			}
			timer = setInterval(() => {
				if (inFlight) return;
				inFlight = true;
				const sweepGeneration = generation;
				void reconcileSessionStates(ctx, () => generation === sweepGeneration)
					.catch((err: unknown) => {
						sessionLog.error("Reconciliation sweep failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					})
					.finally(() => {
						inFlight = false;
					});
			}, SESSION_RECONCILIATION_INTERVAL_MS);
			timer.unref();
		},
		stop() {
			generation += 1;
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
