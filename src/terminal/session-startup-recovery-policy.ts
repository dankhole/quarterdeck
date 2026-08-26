import {
	deriveTaskIndicatorState,
	type RuntimeTaskHookActivity,
	type RuntimeTaskOutstandingInteraction,
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

/**
 * User-visible task meaning to preserve while a previous runtime's process is
 * replaced. Process ownership and semantic state are independent: work that
 * lost its process remains Interrupted until a replacement emits native work
 * evidence, while completed/blocked Review meaning survives unchanged.
 */
export type SessionResumeSemanticState = {
	state: "awaiting_review";
	reviewReason: Exclude<RuntimeTaskSessionReviewReason, null>;
	lastHookAt: number | null;
	latestHookActivity: RuntimeTaskHookActivity | null;
	outstandingInteraction?: RuntimeTaskOutstandingInteraction | null;
};

export type StartupRecoveryPolicy =
	| {
			required: true;
			semanticState: SessionResumeSemanticState;
			fallbackReviewState: StartupRecoveryReviewState | null;
			/** Legacy persistence erased the prior semantic state, so recovery must remain neutral until new evidence arrives. */
			semanticStateUncertain: boolean;
	  }
	| {
			required: false;
			/** Ineligible tasks have no process-recovery state to apply. */
			semanticState: null;
			fallbackReviewState: StartupRecoveryReviewState | null;
			semanticStateUncertain: boolean;
	  };

function cloneHookActivity(activity: RuntimeTaskHookActivity | null): RuntimeTaskHookActivity | null {
	return activity ? { ...activity } : null;
}

function deriveRecoverySemanticState(
	summary: RuntimeTaskSessionSummary,
	semanticStateUncertain: boolean,
): SessionResumeSemanticState {
	if (semanticStateUncertain) {
		return {
			state: "awaiting_review",
			reviewReason: "interrupted",
			lastHookAt: null,
			latestHookActivity: null,
			outstandingInteraction: null,
		};
	}

	if (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "hook" || summary.reviewReason === "attention")
	) {
		return {
			state: "awaiting_review",
			reviewReason: summary.reviewReason,
			lastHookAt: summary.lastHookAt,
			latestHookActivity: cloneHookActivity(summary.latestHookActivity),
			outstandingInteraction: summary.outstandingInteraction ? { ...summary.outstandingInteraction } : null,
		};
	}

	// Every other eligible recovery lost a process while work was active. A
	// replacement TUI and SessionStart identity do not prove the model resumed;
	// keep the task Interrupted until a current work/completion hook resolves it.
	return {
		state: "awaiting_review",
		reviewReason: "interrupted",
		lastHookAt: null,
		latestHookActivity: null,
		outstandingInteraction: null,
	};
}

/**
 * Captures the user-visible meaning that a server-owned resume/restart must
 * preserve while it replaces only the provider process. Unproven legacy
 * attention and formerly Running/processless work fail closed as Interrupted;
 * completed Review, explicit Error, and structured interactions retain their
 * meaning until current provider evidence changes it.
 */
export function deriveSessionResumeSemanticState(summary: RuntimeTaskSessionSummary): SessionResumeSemanticState {
	const indicator = deriveTaskIndicatorState(summary);
	if (summary.state === "awaiting_review" && summary.reviewReason && summary.reviewReason !== "interrupted") {
		if (summary.reviewReason === "attention" && !summary.outstandingInteraction && !indicator.needsInput) {
			return {
				state: "awaiting_review",
				reviewReason: "interrupted",
				lastHookAt: null,
				latestHookActivity: null,
				outstandingInteraction: null,
			};
		}
		return {
			state: "awaiting_review",
			reviewReason: summary.reviewReason,
			lastHookAt: summary.lastHookAt,
			latestHookActivity: cloneHookActivity(summary.latestHookActivity),
			outstandingInteraction: summary.outstandingInteraction ? { ...summary.outstandingInteraction } : null,
		};
	}
	return {
		state: "awaiting_review",
		reviewReason: "interrupted",
		lastHookAt: null,
		latestHookActivity: null,
		outstandingInteraction: null,
	};
}

/**
 * Classifies persisted session meaning separately from process restoration.
 * Startup selection, hydration, and shutdown all use this policy so task
 * indicators cannot drift based on which runtime entry point ran first.
 */
export function deriveStartupRecoveryPolicy(summary: RuntimeTaskSessionSummary): StartupRecoveryPolicy {
	const indicator = deriveTaskIndicatorState(summary);
	const semanticStateUncertain = summary.startupRecoverySemanticStateUncertain === true;
	// Older runtimes also persisted Escape/Ctrl-C recovery as `attention` and
	// could mark that process for startup recovery. The durable process flag
	// must not outweigh the newer structured proof required for Needs Input.
	const hasRecoverableInteraction =
		summary.outstandingInteraction?.status === "waiting" ||
		summary.outstandingInteraction?.status === "response_submitted";
	const hasUnprovenAttention =
		summary.state === "awaiting_review" &&
		summary.reviewReason === "attention" &&
		!indicator.needsInput &&
		!hasRecoverableInteraction;
	const required =
		!hasUnprovenAttention &&
		(summary.startupRecoveryRequired === true ||
			summary.state === "running" ||
			(summary.state === "awaiting_review" &&
				((summary.reviewReason === "attention" && (indicator.needsInput || hasRecoverableInteraction)) ||
					(summary.reviewReason === "hook" &&
						(summary.pid !== null || indicator.needsInput || hasRecoverableInteraction)))));
	const fallbackReviewState: StartupRecoveryReviewState | null =
		summary.state === "awaiting_review" && indicator.reviewReady
			? {
					reviewReason: summary.reviewReason === "hook" ? "hook" : "attention",
					lastHookAt: summary.lastHookAt,
					latestHookActivity: cloneHookActivity(summary.latestHookActivity),
				}
			: null;
	if (!required) {
		return {
			required: false,
			semanticState: null,
			fallbackReviewState,
			semanticStateUncertain,
		};
	}
	return {
		required: true,
		semanticState: deriveRecoverySemanticState(summary, semanticStateUncertain),
		fallbackReviewState,
		semanticStateUncertain,
	};
}
