import { createTaggedLogger, type RuntimeTaskSessionSummary } from "../core";
import { stopWorkspaceTrustTimers } from "./claude-workspace-trust";
import { clearInterruptRecoveryTimer } from "./session-interrupt-recovery";
import type { ProcessEntry, ProviderHookReplayBoundary } from "./session-manager-types";
import type { ProviderHookSessionEvidence } from "./session-state-machine";
import {
	cloneSummary,
	type SessionSummaryStore,
	type SessionTransitionEvent,
	type SessionTransitionResult,
} from "./session-summary-store";

const transitionLog = createTaggedLogger("session-transition");

/**
 * Owns process-side consequences of session state-machine transitions and the
 * summary fanout that active listeners observe.
 */
export class SessionTransitionController {
	private readonly nativeWorkEvidenceTimers = new Map<string, NodeJS.Timeout>();

	constructor(
		private readonly store: SessionSummaryStore,
		private readonly entries: Map<string, ProcessEntry>,
	) {}

	broadcastSummary(summary: RuntimeTaskSessionSummary): void {
		const entry = this.entries.get(summary.taskId);
		if (!entry?.active) {
			return;
		}
		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
	}

	/**
	 * Applies process-side consequences for every authoritative store mutation,
	 * including hook API writes that do not originate in this controller.
	 */
	observeSummaryChange(previous: RuntimeTaskSessionSummary | null, summary: RuntimeTaskSessionSummary): void {
		this.scheduleNativeWorkEvidenceExpiry(summary);
		if (previous?.state === summary.state || summary.state !== "running") {
			return;
		}
		const active = this.entries.get(summary.taskId)?.active;
		if (!active) {
			return;
		}
		clearInterruptRecoveryTimer(active);
		active.resetOutputTransitionDetection?.();
	}

	private scheduleNativeWorkEvidenceExpiry(summary: RuntimeTaskSessionSummary): void {
		const existing = this.nativeWorkEvidenceTimers.get(summary.taskId);
		if (existing) {
			clearTimeout(existing);
			this.nativeWorkEvidenceTimers.delete(summary.taskId);
		}
		const evidence = summary.nativeWorkEvidence;
		if (summary.state !== "running" || !evidence) return;
		const delayMs = Math.max(0, evidence.expiresAt - Date.now());
		const timer = setTimeout(() => {
			if (this.nativeWorkEvidenceTimers.get(summary.taskId) !== timer) return;
			this.nativeWorkEvidenceTimers.delete(summary.taskId);
			const entry = this.entries.get(summary.taskId);
			if (!entry) return;
			this.applyTransitionEvent(entry, {
				type: "native_work.evidence_expired",
				confirmedAt: evidence.confirmedAt,
				occurredAt: Date.now(),
			});
		}, delayMs);
		timer.unref();
		this.nativeWorkEvidenceTimers.set(summary.taskId, timer);
	}

	private hasCurrentSessionHookEvidence(entry: ProcessEntry, event: SessionTransitionEvent): boolean {
		const active = entry.active;
		if (!active || active.session.wasInterrupted()) {
			return false;
		}
		if (event.type !== "provider.hook") {
			return false;
		}
		if (event.metadata?.sessionInstanceId?.trim() !== active.sessionInstanceId) {
			return false;
		}
		const source = event.metadata?.source?.trim().toLowerCase();
		if ((source !== "codex" && source !== "claude" && source !== "pi") || source !== active.agentId) {
			return false;
		}
		// Claude's agent_id marks hooks fired inside a subagent. Those hooks prove
		// neither foreground resumption nor foreground interrupt recovery.
		if (source === "claude" && event.metadata?.providerAgentId?.trim()) {
			return false;
		}
		const interruptStartedAt = active.interruptRecoveryStartedAt;
		return interruptStartedAt === null || (event.occurredAt !== undefined && event.occurredAt > interruptStartedAt);
	}

	canApplyReplayedProviderHook(
		entry: ProcessEntry,
		event: Extract<SessionTransitionEvent, { type: "provider.hook" }>,
	): boolean {
		return this.resolveReplayedProviderHookEvidence(entry, event) !== null;
	}

	private resolveReplayedProviderHookEvidence(
		entry: ProcessEntry,
		event: Extract<SessionTransitionEvent, { type: "provider.hook" }>,
	): Extract<ProviderHookSessionEvidence, "startup_replay" | "exited_replay"> | null {
		const boundary = entry.providerHookReplayBoundary;
		if (
			entry.active ||
			!boundary ||
			event.occurredAt === undefined ||
			(event.deliveryId !== undefined && boundary.recentDeliveryIds.has(event.deliveryId)) ||
			(boundary.legacyOccurredAtFloor !== null && event.occurredAt < boundary.legacyOccurredAtFloor) ||
			(boundary.closedAt !== null && event.occurredAt > boundary.closedAt)
		) {
			return null;
		}
		const summary = this.store.getSummary(entry.taskId);
		const incomingSessionInstanceId = event.metadata?.sessionInstanceId?.trim() || null;
		if (
			!summary ||
			summary.pid !== null ||
			!incomingSessionInstanceId ||
			incomingSessionInstanceId !== boundary.sessionInstanceId ||
			summary.sessionInstanceId !== boundary.sessionInstanceId
		) {
			return null;
		}
		const source = event.metadata?.source?.trim().toLowerCase();
		if ((source !== "codex" && source !== "claude" && source !== "pi") || source !== summary.agentId) return null;
		return boundary.context === "startup" ? "startup_replay" : "exited_replay";
	}

	applyTransitionEvent(
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	): (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null {
		this.captureProcessExitReplayBoundary(entry, event);
		const confirmedEvent = this.withSessionEvidence(entry, event);
		if (
			confirmedEvent.type === "provider.hook" &&
			confirmedEvent.event !== "activity" &&
			confirmedEvent.sessionEvidence === "live" &&
			entry.active
		) {
			// A current native working or completion hook from the current PTY proves
			// that a keyboard interrupt did not terminate the session. Cancel the
			// pending recovery/no-restart policy even when the semantic transition is
			// a no-op because the summary was already Running.
			clearInterruptRecoveryTimer(entry.active);
			entry.suppressAutoRestartOnExit = false;
		}
		const result = this.store.applySessionEvent(entry.taskId, confirmedEvent);
		if (!result?.changed) {
			transitionLog.debug("session transition no-op", {
				taskId: entry.taskId,
				event: event.type,
				currentState: result?.summary.state ?? null,
				currentReviewReason: result?.summary.reviewReason ?? null,
			});
			return result;
		}

		const active = entry.active;
		transitionLog.debug("session transition applied", {
			taskId: entry.taskId,
			event: event.type,
			nextState: result.summary.state,
			nextReviewReason: result.summary.reviewReason,
			nextPid: result.summary.pid,
		});
		if (result.clearAttentionBuffer && active && active.workspaceTrustBuffer !== null) {
			active.workspaceTrustBuffer = "";
		}
		return result;
	}

	private withSessionEvidence(entry: ProcessEntry, event: SessionTransitionEvent): SessionTransitionEvent {
		if (event.type !== "provider.hook") {
			return event;
		}
		// This controller is the sole author of live-process confirmation. Never
		// trust a caller-supplied flag: stale callbacks and test/compatibility code
		// must not be able to bypass process, provider, launch, or interrupt fences.
		const liveSessionConfirmed = this.hasCurrentSessionHookEvidence(entry, event);
		const sessionEvidence: ProviderHookSessionEvidence = liveSessionConfirmed
			? "live"
			: (this.resolveReplayedProviderHookEvidence(entry, event) ?? "unconfirmed");
		return {
			...event,
			sessionEvidence,
			...(liveSessionConfirmed ? { confirmedAt: Date.now() } : {}),
		};
	}

	private captureProcessExitReplayBoundary(entry: ProcessEntry, event: SessionTransitionEvent): void {
		if (event.type !== "process.exit") return;
		const active = entry.active;
		if (
			event.interrupted ||
			!active ||
			(active.agentId !== "codex" && active.agentId !== "claude" && active.agentId !== "pi")
		) {
			entry.providerHookReplayBoundary = null;
			return;
		}
		const summary = this.store.getSummary(entry.taskId);
		const boundary: ProviderHookReplayBoundary = {
			context: "exited",
			sessionInstanceId: active.sessionInstanceId,
			legacyOccurredAtFloor:
				summary?.sessionInstanceId === active.sessionInstanceId &&
				summary.recentProviderHookOrderObservations.length === 0
					? (summary.lastProviderHookOccurredAt ?? null)
					: null,
			recentDeliveryIds: new Set(
				summary?.sessionInstanceId === active.sessionInstanceId ? summary.recentProviderHookDeliveryIds : [],
			),
			closedAt: Date.now(),
		};
		entry.providerHookReplayBoundary = boundary;
	}

	recoverMissingLaunchPath(entry: ProcessEntry, warningMessage: string): RuntimeTaskSessionSummary | null {
		if (!entry.active) {
			return this.store.getSummary(entry.taskId);
		}
		const summary = this.store.getSummary(entry.taskId);
		transitionLog.warn("stopping task session because its launch folder no longer exists", {
			taskId: entry.taskId,
			sessionLaunchPath: summary?.sessionLaunchPath ?? null,
			pid: summary?.pid ?? entry.active.session.pid,
		});
		entry.suppressAutoRestartOnExit = true;
		stopWorkspaceTrustTimers(entry.active);
		clearInterruptRecoveryTimer(entry.active);
		const result = this.applyTransitionEvent(entry, {
			type: "reconciliation.launch_path_missing",
			warningMessage,
		});
		entry.active.session.stop({ interrupted: true });
		return result?.summary ?? this.store.getSummary(entry.taskId);
	}
}
