import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export type SessionStatusTagStyle = "neutral" | "success" | "warning" | "danger";

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
				return "Ready for review";
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
				return "warning";
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
};
