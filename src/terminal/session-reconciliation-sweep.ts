// Reconciliation sweep orchestration — runs the periodic check loop and applies
// corrective actions. The individual check functions live in session-reconciliation.ts;
// this module owns the timer lifecycle and action execution.

import type { RuntimeTaskSessionSummary } from "../core";
import { createTaggedLogger } from "../core";
import { stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import { clearInterruptRecoveryTimer } from "./session-interrupt-recovery";
import type { ProcessEntry } from "./session-manager-types";
import { finalizeProcessExit } from "./session-manager-types";
import { type ReconciliationAction, reconciliationChecks } from "./session-reconciliation";
import type { SessionSummaryStore, SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";

const sessionLog = createTaggedLogger("session-reconciliation");

export const SESSION_RECONCILIATION_INTERVAL_MS = 10_000;

export interface ReconciliationSweepContext {
	entries: Map<string, ProcessEntry>;
	store: SessionSummaryStore;
	applyTransitionEvent: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
}

/** Run one reconciliation sweep across all active entries. */
export function reconcileSessionStates(ctx: ReconciliationSweepContext): void {
	const nowMs = Date.now();
	for (const entry of ctx.entries.values()) {
		try {
			const summary = ctx.store.getSummary(entry.taskId);
			if (
				!summary ||
				(summary.state !== "running" && summary.state !== "awaiting_review" && summary.state !== "interrupted")
			) {
				continue;
			}

			for (const check of reconciliationChecks) {
				const action = check(
					{
						summary,
						active: entry.active,
						restartRequest: entry.restartRequest,
						pendingAutoRestart: entry.pendingAutoRestart,
						pendingSessionStart: entry.pendingSessionStart,
					},
					nowMs,
				);
				if (action) {
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
		case "move_interrupted_to_review": {
			ctx.applyTransitionEvent(entry, { type: "autorestart.denied" });
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

	return {
		start() {
			if (timer) {
				return;
			}
			timer = setInterval(() => {
				reconcileSessionStates(ctx);
			}, SESSION_RECONCILIATION_INTERVAL_MS);
			timer.unref();
		},
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
