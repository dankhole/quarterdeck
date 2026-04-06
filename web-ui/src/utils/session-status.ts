import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export type SessionStatusTagStyle = "neutral" | "success" | "warning" | "danger" | "info";

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

export function getSessionStatusTagStyle(summary: RuntimeTaskSessionSummary | null): SessionStatusTagStyle {
	if (!summary) {
		return "neutral";
	}
	if (summary.state === "running") {
		return "success";
	}
	if (summary.state === "awaiting_review") {
		switch (summary.reviewReason) {
			case "exit":
				return "success";
			case "error":
				return "danger";
			case "interrupted":
				return "neutral";
			default:
				return isPermissionRequest(summary) ? "warning" : "info";
		}
	}
	if (summary.state === "interrupted" || summary.state === "failed") {
		return "danger";
	}
	return "neutral";
}

export const sessionStatusTagColors: Record<SessionStatusTagStyle, string> = {
	neutral: "bg-surface-3 text-text-secondary",
	success: "bg-status-green/15 text-status-green",
	warning: "bg-status-orange/15 text-status-orange",
	danger: "bg-status-red/15 text-status-red",
	info: "bg-status-blue/15 text-status-blue",
};
