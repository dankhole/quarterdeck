import { deriveTaskIndicatorState, type RuntimeTaskIndicatorTone } from "@runtime-contract";
import { type StatusBadgeStyle, statusBadgeColors } from "@/data/column-colors";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export { type StatusBadgeStyle, statusBadgeColors };

export function isApprovalState(summary: RuntimeTaskSessionSummary | null): boolean {
	return summary ? deriveTaskIndicatorState(summary).approvalRequired : false;
}

export function describeSessionState(summary: RuntimeTaskSessionSummary | null): string {
	if (!summary) {
		return "No session yet";
	}
	switch (deriveTaskIndicatorState(summary).kind) {
		case "running":
			return "Running";
		case "approval_required":
			return "Waiting for approval";
		case "review_ready":
			return "Ready for review";
		case "needs_input":
			return "Waiting for input";
		case "completed":
			return "Completed";
		case "error":
			return "Error";
		case "failed":
			return "Failed";
		case "stalled":
			return "Stalled";
		case "interrupted":
			return "Interrupted";
		default:
			return "Idle";
	}
}

export function getSessionStatusTooltip(summary: RuntimeTaskSessionSummary | null): string | null {
	if (!summary) return null;
	if (deriveTaskIndicatorState(summary).kind === "stalled") {
		return "No activity for several minutes \u2014 the agent may be stalled or could still be thinking";
	}
	return null;
}

export function getSessionStatusBadgeStyle(summary: RuntimeTaskSessionSummary | null): StatusBadgeStyle {
	if (!summary) {
		return "neutral";
	}
	const tone: RuntimeTaskIndicatorTone = deriveTaskIndicatorState(summary).tone;
	const badgeStyle: StatusBadgeStyle = tone;
	return badgeStyle;
}
