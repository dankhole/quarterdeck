import {
	deriveTaskIndicatorState,
	type RuntimeTaskHookActivity,
	type RuntimeTaskSessionReviewReason,
	type RuntimeTaskSessionSummary,
} from "../core";

export const LEGACY_STARTUP_SEMANTIC_STATE_WARNING =
	"This task was recovered from legacy session data that no longer records whether it was running, ready for review, or waiting for input before shutdown. Quarterdeck restored the chat without guessing that missing state; verify the task after the next agent event or interaction.";

export function appendLegacySemanticStateWarning(existing: string | null | undefined): string {
	if (!existing) return LEGACY_STARTUP_SEMANTIC_STATE_WARNING;
	if (existing.includes(LEGACY_STARTUP_SEMANTIC_STATE_WARNING)) return existing;
	return `${existing} ${LEGACY_STARTUP_SEMANTIC_STATE_WARNING}`;
}

export function removeLegacySemanticStateWarning(existing: string | null | undefined): string | null {
	if (!existing) return null;
	const remaining = existing.replace(LEGACY_STARTUP_SEMANTIC_STATE_WARNING, "").trim();
	return remaining || null;
}

export type StartupRecoveryReviewReason = Extract<RuntimeTaskSessionReviewReason, "attention" | "hook" | "interrupted">;

export interface StartupRecoveryReviewState {
	reviewReason: StartupRecoveryReviewReason;
	lastHookAt: number | null;
	latestHookActivity: RuntimeTaskHookActivity | null;
}

export interface StartupRecoveryPolicy {
	required: boolean;
	reviewState: StartupRecoveryReviewState;
	fallbackReviewState: StartupRecoveryReviewState | null;
	/** Legacy persistence erased the prior semantic state, so recovery must remain neutral until new evidence arrives. */
	semanticStateUncertain: boolean;
}

/**
 * Classifies persisted session meaning separately from process restoration.
 * Startup selection, hydration, and shutdown all use this policy so task
 * indicators cannot drift based on which runtime entry point ran first.
 */
export function deriveStartupRecoveryPolicy(summary: RuntimeTaskSessionSummary): StartupRecoveryPolicy {
	const indicator = deriveTaskIndicatorState(summary);
	const hasDurableRecoveryDecision = typeof summary.startupRecoveryRequired === "boolean";
	const semanticStateUncertain =
		summary.startupRecoverySemanticStateUncertain === true ||
		(!hasDurableRecoveryDecision && summary.state === "interrupted" && summary.reviewReason === "interrupted");
	const required =
		summary.startupRecoveryRequired === true ||
		summary.state === "running" ||
		(summary.state === "interrupted" &&
			summary.reviewReason === "interrupted" &&
			summary.startupRecoveryRequired !== false) ||
		(summary.state === "awaiting_review" &&
			(summary.reviewReason === "attention" ||
				(summary.reviewReason === "hook" && (summary.pid !== null || indicator.needsInput))));
	const reviewState: StartupRecoveryReviewState = {
		reviewReason: semanticStateUncertain
			? "interrupted"
			: summary.state === "awaiting_review" && summary.reviewReason === "hook"
				? "hook"
				: "attention",
		lastHookAt: summary.state === "awaiting_review" ? summary.lastHookAt : null,
		latestHookActivity:
			summary.state === "awaiting_review" && summary.latestHookActivity ? { ...summary.latestHookActivity } : null,
	};
	return {
		required,
		reviewState,
		fallbackReviewState:
			summary.state === "awaiting_review" && indicator.reviewReady
				? {
						...reviewState,
						latestHookActivity: reviewState.latestHookActivity ? { ...reviewState.latestHookActivity } : null,
					}
				: null,
		semanticStateUncertain,
	};
}
