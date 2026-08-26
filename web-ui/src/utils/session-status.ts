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
		case "unconfirmed":
			return "Review";
		case "approval_required":
			return "Waiting for approval";
		case "response_pending":
			return "Response sent — awaiting agent confirmation";
		case "interaction_unknown":
			return "Response outcome unknown";
		case "review_ready":
			return "Ready for review";
		case "needs_input":
			return "Waiting for input";
		case "completed":
			return "Completed";
		case "error":
			return "Error";
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
	if (deriveTaskIndicatorState(summary).kind === "response_pending") {
		return "Quarterdeck delivered the response, but the provider has not yet confirmed resumed work";
	}
	if (deriveTaskIndicatorState(summary).kind === "interaction_unknown") {
		return "The provider process ended before Quarterdeck could confirm whether the response was applied";
	}
	if (deriveTaskIndicatorState(summary).kind === "unconfirmed") {
		return "No current launch-scoped provider event confirms that agent work is running";
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
