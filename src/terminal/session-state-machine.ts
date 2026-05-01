import { deriveTaskIndicatorState, type RuntimeTaskSessionReviewReason, type RuntimeTaskSessionSummary } from "../core";

export type SessionTransitionEvent =
	| { type: "hook.to_review" }
	| { type: "hook.to_in_progress" }
	| { type: "agent.prompt-ready" }
	| { type: "user.stop" }
	| { type: "process.exit"; exitCode: number | null; interrupted: boolean }
	| { type: "interrupt.recovery" }
	| { type: "autorestart.denied" };

export interface SessionTransitionResult {
	changed: boolean;
	patch: Partial<RuntimeTaskSessionSummary>;
	clearAttentionBuffer: boolean;
}

export function canReturnToRunning(reason: RuntimeTaskSessionReviewReason): boolean {
	// "exit" was previously excluded, creating a permanent dead state — a task
	// that exited cleanly could never transition back to running via hooks.
	// Explicit stops use "interrupted" as a non-returnable review reason.
	// "stalled" is kept for older persisted summaries; new sessions no longer
	// enter that review reason via reconciliation.
	return (
		reason === "attention" || reason === "hook" || reason === "error" || reason === "exit" || reason === "stalled"
	);
}

function asReviewState(reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary["state"] {
	if (reason === "interrupted") {
		return "interrupted";
	}
	return "awaiting_review";
}

export function reduceSessionTransition(
	summary: RuntimeTaskSessionSummary,
	event: SessionTransitionEvent,
): SessionTransitionResult {
	switch (event.type) {
		case "hook.to_review": {
			if (summary.state !== "running") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "hook",
				},
				clearAttentionBuffer: true,
			};
		}
		case "hook.to_in_progress":
		case "agent.prompt-ready": {
			if (summary.state !== "awaiting_review" || !canReturnToRunning(summary.reviewReason)) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "running",
					reviewReason: null,
					stalledSince: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "interrupt.recovery": {
			if (summary.state !== "running") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "attention",
				},
				clearAttentionBuffer: true,
			};
		}
		case "user.stop": {
			if (summary.state !== "running" && summary.state !== "awaiting_review") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			if (summary.state === "awaiting_review" && !deriveTaskIndicatorState(summary).needsInput) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "interrupted",
					latestHookActivity: null,
					stalledSince: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "process.exit": {
			if (summary.state === "interrupted") {
				return {
					changed: true,
					patch: {
						exitCode: event.exitCode,
						pid: null,
					},
					clearAttentionBuffer: false,
				};
			}
			// If the session is already in awaiting_review, the agent already
			// handed off (via hook, clean exit, etc.). The process dying after
			// that is just cleanup noise — preserve the existing review reason
			// so the card still shows "Ready for review" instead of flipping
			// to "Error". We still clear pid and record exitCode.
			if (summary.state === "awaiting_review") {
				return {
					changed: true,
					patch: {
						exitCode: event.exitCode,
						pid: null,
					},
					clearAttentionBuffer: false,
				};
			}
			let reason: RuntimeTaskSessionReviewReason = event.exitCode === 0 ? "exit" : "error";
			if (event.interrupted) {
				reason = "interrupted";
			}
			return {
				changed: true,
				patch: {
					state: asReviewState(reason),
					reviewReason: reason,
					exitCode: event.exitCode,
					pid: null,
				},
				clearAttentionBuffer: false,
			};
		}
		case "autorestart.denied": {
			if (summary.state !== "interrupted") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "interrupted",
				},
				clearAttentionBuffer: false,
			};
		}
		default: {
			return { changed: false, patch: {}, clearAttentionBuffer: false };
		}
	}
}
