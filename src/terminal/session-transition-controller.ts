import type { RuntimeTaskSessionSummary } from "../core";
import { clearInterruptRecoveryTimer } from "./session-interrupt-recovery";
import type { ProcessEntry } from "./session-manager-types";
import {
	cloneSummary,
	type SessionSummaryStore,
	type SessionTransitionEvent,
	type SessionTransitionResult,
} from "./session-summary-store";

/**
 * Owns process-side consequences of session state-machine transitions and the
 * summary fanout that active listeners observe.
 */
export class SessionTransitionController {
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

	applyTransitionEvent(
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	): (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null {
		const result = this.store.applySessionEvent(entry.taskId, event);
		if (!result?.changed) {
			return result;
		}

		const active = entry.active;
		if (result.clearAttentionBuffer && active && active.workspaceTrustBuffer !== null) {
			active.workspaceTrustBuffer = "";
		}
		if (active && result.patch.state === "running") {
			clearInterruptRecoveryTimer(active);
		}
		if (active && result.patch.state === "awaiting_review") {
			active.awaitingCodexPromptAfterEnter = false;
		}
		return result;
	}
}
