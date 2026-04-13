import type { RuntimeTaskSessionReviewReason, RuntimeTaskSessionSummary } from "../core/api-contract";

export type SessionTransitionEvent =
	| { type: "hook.to_review" }
	| { type: "hook.to_in_progress" }
	| { type: "agent.prompt-ready" }
	| { type: "process.exit"; exitCode: number | null; interrupted: boolean }
	| { type: "interrupt.recovery" }
	| { type: "reconciliation.stalled" };

export interface SessionTransitionResult {
	changed: boolean;
	patch: Partial<RuntimeTaskSessionSummary>;
	clearAttentionBuffer: boolean;
}

export function canReturnToRunning(reason: RuntimeTaskSessionReviewReason): boolean {
	// "exit" was previously excluded, creating a permanent dead state — a task
	// that exited cleanly could never transition back to running via hooks.
	// Note: "interrupted" maps to state "interrupted" (not "awaiting_review"),
	// so it's handled by a different path and isn't relevant here.
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
		case "process.exit": {
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
		case "reconciliation.stalled": {
			if (summary.state !== "running") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "stalled",
					stalledSince: Date.now(),
				},
				clearAttentionBuffer: true,
			};
		}
		default: {
			return { changed: false, patch: {}, clearAttentionBuffer: false };
		}
	}
}
