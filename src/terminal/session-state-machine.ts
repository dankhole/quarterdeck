import {
	deriveTaskIndicatorState,
	type RuntimeHookMetadata,
	type RuntimeTaskSessionReviewReason,
	type RuntimeTaskSessionSummary,
} from "../core";
import { removeLegacySemanticStateWarning, type StartupRecoveryReviewState } from "./session-startup-recovery-policy";

export type HookSessionReviewReason = Extract<RuntimeTaskSessionReviewReason, "hook" | "attention" | "error">;

export type SessionTransitionEvent =
	| { type: "hook.to_review"; reason?: HookSessionReviewReason; metadata?: RuntimeHookMetadata }
	| { type: "hook.to_in_progress"; metadata?: RuntimeHookMetadata }
	| { type: "agent.prompt-ready" }
	| { type: "agent.permission-prompt" }
	| { type: "user.responded" }
	| { type: "user.submitted" }
	| { type: "user.stop" }
	| { type: "process.exit"; exitCode: number | null; interrupted: boolean }
	| { type: "interrupt.recovery" }
	| { type: "autorestart.denied" }
	| { type: "reconciliation.launch_path_missing"; warningMessage: string }
	| {
			type: "startup_recovery.exhausted";
			processStillRunning: boolean;
			clearResumeSessionId: boolean;
			warningMessage: string;
			fallbackReviewState: StartupRecoveryReviewState | null;
	  };

export type HookSessionTransitionEvent = Extract<
	SessionTransitionEvent,
	{ type: "hook.to_review" | "hook.to_in_progress" }
>;

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

function clearSemanticUncertainty(summary: RuntimeTaskSessionSummary): Partial<RuntimeTaskSessionSummary> {
	if (summary.startupRecoverySemanticStateUncertain !== true) return {};
	return {
		startupRecoverySemanticStateUncertain: false,
		warningMessage: removeLegacySemanticStateWarning(summary.warningMessage),
	};
}

export function reduceSessionTransition(
	summary: RuntimeTaskSessionSummary,
	event: SessionTransitionEvent,
): SessionTransitionResult {
	switch (event.type) {
		case "agent.permission-prompt": {
			if (
				(summary.state !== "running" && summary.startupRecoverySemanticStateUncertain !== true) ||
				summary.agentId !== "codex"
			) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					...clearSemanticUncertainty(summary),
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: {
						activityText: "Waiting for approval",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "PermissionRequest",
						notificationType: "permission.asked",
						source: "codex",
						conversationSummaryText: null,
					},
				},
				clearAttentionBuffer: true,
			};
		}
		case "hook.to_review": {
			if (summary.state !== "running" && summary.startupRecoverySemanticStateUncertain !== true) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			const reason = event.reason ?? "hook";
			return {
				changed: true,
				patch: {
					...clearSemanticUncertainty(summary),
					state: asReviewState(reason),
					reviewReason: reason,
				},
				clearAttentionBuffer: true,
			};
		}
		case "hook.to_in_progress":
		case "agent.prompt-ready": {
			if (
				(summary.state !== "awaiting_review" || !canReturnToRunning(summary.reviewReason)) &&
				summary.startupRecoverySemanticStateUncertain !== true
			) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					...clearSemanticUncertainty(summary),
					state: "running",
					reviewReason: null,
					latestHookActivity: null,
					stalledSince: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "user.responded": {
			if (summary.state !== "awaiting_review" || !deriveTaskIndicatorState(summary).needsInput) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "running",
					reviewReason: null,
					latestHookActivity: null,
					stalledSince: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "user.submitted": {
			if (
				(summary.state !== "awaiting_review" || !canReturnToRunning(summary.reviewReason)) &&
				summary.startupRecoverySemanticStateUncertain !== true
			) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					...clearSemanticUncertainty(summary),
					state: "running",
					reviewReason: null,
					latestHookActivity: null,
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
		case "reconciliation.launch_path_missing": {
			if (summary.state !== "running" && summary.state !== "awaiting_review") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "error",
					latestHookActivity: null,
					stalledSince: null,
					warningMessage: event.warningMessage,
				},
				clearAttentionBuffer: true,
			};
		}
		case "startup_recovery.exhausted": {
			if (event.fallbackReviewState) {
				return {
					changed: true,
					patch: {
						state: "awaiting_review",
						reviewReason: event.fallbackReviewState.reviewReason,
						...(event.processStillRunning ? {} : { pid: null }),
						lastHookAt: event.fallbackReviewState.lastHookAt,
						latestHookActivity: event.fallbackReviewState.latestHookActivity
							? { ...event.fallbackReviewState.latestHookActivity }
							: null,
						stalledSince: null,
						startupRecoveryRequired: false,
						...(event.clearResumeSessionId ? { resumeSessionId: null } : {}),
						warningMessage: event.warningMessage,
					},
					clearAttentionBuffer: true,
				};
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "error",
					...(event.processStillRunning ? {} : { pid: null }),
					latestHookActivity: null,
					stalledSince: null,
					startupRecoveryRequired: false,
					...(event.clearResumeSessionId ? { resumeSessionId: null } : {}),
					warningMessage: event.warningMessage,
				},
				clearAttentionBuffer: true,
			};
		}
		default: {
			return { changed: false, patch: {}, clearAttentionBuffer: false };
		}
	}
}
