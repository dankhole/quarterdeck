import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "./task-session.js";

export type RuntimeTaskIndicatorKind =
	| "idle"
	| "running"
	| "approval_required"
	| "review_ready"
	| "needs_input"
	| "completed"
	| "error"
	| "failed"
	| "stalled"
	| "interrupted";

export type RuntimeTaskIndicatorTone = "neutral" | "running" | "review" | "needs_input" | "error";

export type RuntimeTaskIndicatorColumn = "active" | "stopped" | "silent";

export type RuntimeTaskIndicatorNotification = "permission" | "review" | "failure";

export interface RuntimeTaskIndicatorState {
	kind: RuntimeTaskIndicatorKind;
	tone: RuntimeTaskIndicatorTone;
	column: RuntimeTaskIndicatorColumn;
	notification: RuntimeTaskIndicatorNotification | null;
	approvalRequired: boolean;
	needsInput: boolean;
	reviewReady: boolean;
	failure: boolean;
	hookReview: boolean;
}

function createIndicatorState(
	kind: RuntimeTaskIndicatorKind,
	{
		tone,
		column,
		notification = null,
		approvalRequired = false,
		needsInput = false,
		reviewReady = false,
		failure = false,
		hookReview = false,
	}: {
		tone: RuntimeTaskIndicatorTone;
		column: RuntimeTaskIndicatorColumn;
		notification?: RuntimeTaskIndicatorNotification | null;
		approvalRequired?: boolean;
		needsInput?: boolean;
		reviewReady?: boolean;
		failure?: boolean;
		hookReview?: boolean;
	},
): RuntimeTaskIndicatorState {
	return {
		kind,
		tone,
		column,
		notification,
		approvalRequired,
		needsInput,
		reviewReady,
		failure,
		hookReview,
	};
}

export function isPermissionActivity(activity: RuntimeTaskHookActivity | null | undefined): boolean {
	if (!activity) {
		return false;
	}
	const hook = activity.hookEventName?.toLowerCase() ?? "";
	const notif = activity.notificationType?.toLowerCase() ?? "";
	const text = activity.activityText?.toLowerCase() ?? "";
	return (
		hook === "permissionrequest" ||
		notif === "permission_prompt" ||
		notif === "permission.asked" ||
		text === "waiting for approval"
	);
}

export function deriveTaskIndicatorState(summary: RuntimeTaskSessionSummary): RuntimeTaskIndicatorState {
	if (summary.state === "running") {
		return createIndicatorState("running", {
			tone: "running",
			column: "active",
		});
	}

	if (summary.state === "failed") {
		return createIndicatorState("failed", {
			tone: "error",
			column: "stopped",
			notification: "failure",
			failure: true,
		});
	}

	if (summary.state === "interrupted") {
		return createIndicatorState("interrupted", {
			tone: "error",
			column: "silent",
		});
	}

	if (summary.state === "awaiting_review") {
		const hookReview = summary.reviewReason === "hook";
		const approvalRequired = hookReview && isPermissionActivity(summary.latestHookActivity);
		if (approvalRequired) {
			return createIndicatorState("approval_required", {
				tone: "needs_input",
				column: "stopped",
				notification: "permission",
				approvalRequired: true,
				needsInput: true,
				hookReview: true,
			});
		}

		switch (summary.reviewReason) {
			case "hook":
				return createIndicatorState("review_ready", {
					tone: "review",
					column: "stopped",
					notification: "review",
					reviewReady: true,
					hookReview: true,
				});
			case "attention":
				return createIndicatorState("needs_input", {
					// Preserve the existing badge tone for attention-style review while
					// still exposing the stronger semantic meaning to downstream consumers.
					tone: "review",
					column: "stopped",
					notification: "review",
					needsInput: true,
				});
			case "exit":
				return createIndicatorState("completed", {
					tone: "review",
					column: "stopped",
					notification: summary.exitCode === 0 ? "review" : "failure",
					reviewReady: true,
				});
			case "error":
				return createIndicatorState("error", {
					tone: "error",
					column: "stopped",
					notification: "failure",
					failure: true,
				});
			case "interrupted":
				return createIndicatorState("interrupted", {
					tone: "neutral",
					column: "silent",
				});
			case "stalled":
				return createIndicatorState("stalled", {
					tone: "review",
					column: "stopped",
					reviewReady: true,
				});
			default:
				return createIndicatorState("review_ready", {
					tone: "review",
					column: "stopped",
					reviewReady: true,
				});
		}
	}

	return createIndicatorState("idle", {
		tone: "neutral",
		column: "stopped",
	});
}
