import { type StatusBadgeStyle, statusBadgeColors } from "@/data/column-colors";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export { type StatusBadgeStyle, statusBadgeColors };

export function isApprovalState(summary: RuntimeTaskSessionSummary | null): boolean {
	if (!summary) return false;
	return summary.state === "awaiting_review" && summary.reviewReason === "hook" && isPermissionRequest(summary);
}

function isPermissionRequest(summary: RuntimeTaskSessionSummary): boolean {
	const activity = summary.latestHookActivity;
	if (!activity) return false;
	const hook = activity.hookEventName?.toLowerCase() ?? "";
	const notif = activity.notificationType?.toLowerCase() ?? "";
	return (
		hook === "permissionrequest" ||
		notif === "permission_prompt" ||
		notif === "permission.asked" ||
		(activity.activityText?.toLowerCase() ?? "") === "waiting for approval"
	);
}

export function describeSessionState(summary: RuntimeTaskSessionSummary | null): string {
	if (!summary) {
		return "No session yet";
	}
	if (summary.state === "running") {
		return "Running";
	}
	if (summary.state === "awaiting_review") {
		switch (summary.reviewReason) {
			case "exit":
				return "Completed";
			case "hook":
				return isPermissionRequest(summary) ? "Waiting for approval" : "Ready for review";
			case "attention":
				return "Waiting for input";
			case "error":
				return "Error";
			case "interrupted":
				return "Interrupted";
			default:
				return "Ready for review";
		}
	}
	if (summary.state === "interrupted") {
		return "Interrupted";
	}
	if (summary.state === "failed") {
		return "Failed";
	}
	return "Idle";
}

export function getSessionStatusBadgeStyle(summary: RuntimeTaskSessionSummary | null): StatusBadgeStyle {
	if (!summary) {
		return "neutral";
	}
	if (summary.state === "running") {
		return "running";
	}
	if (summary.state === "awaiting_review") {
		switch (summary.reviewReason) {
			case "exit":
				return "review";
			case "error":
				return "error";
			case "interrupted":
				return "neutral";
			default:
				return isPermissionRequest(summary) ? "needs_input" : "review";
		}
	}
	if (summary.state === "interrupted" || summary.state === "failed") {
		return "error";
	}
	return "neutral";
}
