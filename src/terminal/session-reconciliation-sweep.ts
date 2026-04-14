// Reconciliation sweep orchestration — runs the periodic check loop and applies
// corrective actions. The individual check functions live in session-reconciliation.ts;
// this module owns the timer lifecycle and action execution.

import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { createTaggedLogger } from "../core/debug-logger";
import { emitSessionEvent } from "../core/event-log";
import { cleanStaleGitIndexLocks } from "../fs/lock-cleanup";
import { stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import { clearInterruptRecoveryTimer } from "./session-interrupt-recovery";
import type { ProcessEntry } from "./session-manager-types";
import { finalizeProcessExit } from "./session-manager-types";
import { isProcessAlive, type ReconciliationAction, reconciliationChecks } from "./session-reconciliation";
import type { SessionSummaryStore, SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";

const sessionLog = createTaggedLogger("session-reconciliation");

export const SESSION_RECONCILIATION_INTERVAL_MS = 10_000;

export interface ReconciliationSweepContext {
	entries: Map<string, ProcessEntry>;
	store: SessionSummaryStore;
	applySessionEventWithSideEffects: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
}

/** Run one reconciliation sweep across all active entries. */
export function reconcileSessionStates(ctx: ReconciliationSweepContext, repoPath: string | null): void {
	// Sweep stale git index.lock files from worktrees. This is fire-and-forget
	// and cheap (just stat + unlink per worktree dir). Runs alongside session
	// reconciliation to catch locks orphaned by killed agent processes.
	if (repoPath) {
		void cleanStaleGitIndexLocks([repoPath]).catch(() => {});
	}

	const nowMs = Date.now();
	let sessionsChecked = 0;
	let actionsApplied = 0;
	for (const entry of ctx.entries.values()) {
		try {
			const summary = ctx.store.getSummary(entry.taskId);
			if (
				!summary ||
				(summary.state !== "running" && summary.state !== "awaiting_review" && summary.state !== "interrupted")
			) {
				continue;
			}
			sessionsChecked += 1;

			// Emit health snapshot for every active session.
			const pid = summary.pid;
			emitSessionEvent(entry.taskId, "health.snapshot", {
				state: summary.state,
				reviewReason: summary.reviewReason,
				pid,
				processAlive: pid != null ? isProcessAlive(pid) : false,
				msSinceStart: summary.startedAt != null ? nowMs - summary.startedAt : null,
				msSinceLastOutput: summary.lastOutputAt != null ? nowMs - summary.lastOutputAt : null,
				msSinceLastHook: summary.lastHookAt != null ? nowMs - summary.lastHookAt : null,
				msSinceLastStateChange: nowMs - summary.updatedAt,
				hookCount: entry.hookCount,
				listenerCount: entry.listeners.size,
				autoRestartCount: entry.autoRestartTimestamps.length,
			});

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
					emitSessionEvent(entry.taskId, "reconciliation.action", {
						actionType: action.type,
						currentState: summary.state,
						pid: summary.pid,
					});
					applyReconciliationAction(entry, action, ctx);
					actionsApplied += 1;
					break;
				}
			}
		} catch (err) {
			sessionLog.error(`Reconciliation error for ${entry.taskId}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (sessionsChecked > 0) {
		emitSessionEvent("_system", "reconciliation.sweep", {
			sessionsChecked,
			actionsApplied,
		});
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
			const result = ctx.applySessionEventWithSideEffects(entry, {
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
			ctx.applySessionEventWithSideEffects(entry, {
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
		case "mark_stalled": {
			ctx.applySessionEventWithSideEffects(entry, { type: "reconciliation.stalled" });
			break;
		}
		case "move_interrupted_to_review": {
			ctx.applySessionEventWithSideEffects(entry, { type: "autorestart.denied" });
			break;
		}
	}
}

/** Creates and manages the periodic reconciliation interval timer. */
export function createReconciliationTimer(ctx: ReconciliationSweepContext): {
	start(repoPath?: string): void;
	stop(): void;
} {
	let timer: NodeJS.Timeout | null = null;
	let storedRepoPath: string | null = null;

	return {
		start(repoPath?: string) {
			if (timer) {
				return;
			}
			if (repoPath) {
				storedRepoPath = repoPath;
			}
			timer = setInterval(() => {
				reconcileSessionStates(ctx, storedRepoPath);
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
