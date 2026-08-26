import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "./task-session.js";

export type RuntimeTaskIndicatorKind =
	| "idle"
	| "running"
	| "unconfirmed"
	| "approval_required"
	| "response_pending"
	| "interaction_unknown"
	| "review_ready"
	| "needs_input"
	| "completed"
	| "error"
	| "stalled"
	| "interrupted";

export type RuntimeTaskIndicatorTone = "neutral" | "running" | "review" | "needs_input" | "error";

export type RuntimeTaskIndicatorColumn = "active" | "stopped" | "silent";

export type RuntimeTaskIndicatorNotification = "permission" | "review" | "failure";

export type RuntimeTaskPublicStatus = "none" | "running" | "review" | "needs_input" | "error";

export interface RuntimeTaskIndicatorState {
	kind: RuntimeTaskIndicatorKind;
	publicStatus: RuntimeTaskPublicStatus;
	tone: RuntimeTaskIndicatorTone;
	column: RuntimeTaskIndicatorColumn;
	notification: RuntimeTaskIndicatorNotification | null;
	approvalRequired: boolean;
	needsInput: boolean;
	reviewReady: boolean;
	failure: boolean;
	hookReview: boolean;
}

export type RuntimeSessionWorkColumn = "in_progress" | "review";

/**
 * Returns the browser-owned work column implied by authoritative runtime
 * session state. Keeping this mapping in the shared semantic layer prevents
 * hydration, live projection, and diagnostics from inventing separate rules.
 */
export function getRuntimeSessionWorkColumn(summary: RuntimeTaskSessionSummary): RuntimeSessionWorkColumn | null {
	const publicStatus = deriveTaskIndicatorState(summary).publicStatus;
	if (publicStatus === "running") return "in_progress";
	if (publicStatus !== "none") return "review";
	return null;
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
	const publicStatus: RuntimeTaskPublicStatus =
		kind === "idle"
			? "none"
			: kind === "running"
				? "running"
				: needsInput
					? "needs_input"
					: failure
						? "error"
						: "review";
	return {
		kind,
		publicStatus,
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
	const source = activity.source?.toLowerCase() ?? "";
	// Claude Notification hooks are presentation signals with human-readable
	// text, not an exact actionable interaction identity. Persisted legacy
	// notification activity must not be promoted back into task authority.
	if (source === "claude" && hook === "notification") return false;
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
	const interaction = summary.outstandingInteraction ?? null;
	if (interaction?.status === "response_submitted") {
		return createIndicatorState("response_pending", {
			tone: "review",
			column: "stopped",
		});
	}
	if (interaction?.status === "resolution_unknown") {
		return createIndicatorState("interaction_unknown", {
			tone: "error",
			column: "stopped",
			notification: "failure",
			failure: true,
		});
	}
	if (interaction?.status === "waiting") {
		if (interaction.kind === "permission") {
			return createIndicatorState("approval_required", {
				tone: "needs_input",
				column: "stopped",
				notification: "permission",
				approvalRequired: true,
				needsInput: true,
				hookReview: true,
			});
		}
		return createIndicatorState("needs_input", {
			tone: "review",
			column: "stopped",
			notification: "review",
			needsInput: true,
		});
	}

	if (summary.state === "running") {
		const evidence = summary.nativeWorkEvidence;
		if (
			(summary.agentId === "codex" || summary.agentId === "claude" || summary.agentId === "pi") &&
			(!evidence ||
				evidence.provider !== summary.agentId ||
				evidence.sessionInstanceId !== summary.sessionInstanceId ||
				summary.pid === null)
		) {
			return createIndicatorState("unconfirmed", {
				tone: "review",
				column: "stopped",
			});
		}
		return createIndicatorState("running", {
			tone: "running",
			column: "active",
		});
	}

	if (summary.state === "awaiting_review") {
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
				return createIndicatorState("interrupted", {
					tone: "neutral",
					column: "silent",
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
			case "unconfirmed":
				return createIndicatorState("unconfirmed", {
					tone: "review",
					column: "stopped",
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

/**
 * Returns whether one authoritative mutation newly entered an ordinary
 * review-ready result. Notifications and turn checkpoints must use this same
 * semantic edge instead of reclassifying raw provider events.
 */
export function didEnterTaskReviewReady(previous: RuntimeTaskSessionSummary, next: RuntimeTaskSessionSummary): boolean {
	const previousIndicator = deriveTaskIndicatorState(previous);
	const nextIndicator = deriveTaskIndicatorState(next);
	return (
		next.state === "awaiting_review" &&
		nextIndicator.reviewReady &&
		nextIndicator.notification === "review" &&
		!(previousIndicator.reviewReady && previousIndicator.notification === "review")
	);
}
