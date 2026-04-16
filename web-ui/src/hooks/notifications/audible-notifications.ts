import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { AudibleNotificationEventType } from "@/utils/notification-audio";
import { isApprovalState } from "@/utils/session-status";

export const SETTLE_WINDOW_HOOK_MS = 500;
export const SETTLE_WINDOW_IMMEDIATE_MS = 0;

export function getSettleWindowMs(summary: RuntimeTaskSessionSummary): number {
	if (summary.state === "awaiting_review" && summary.reviewReason === "hook") {
		return SETTLE_WINDOW_HOOK_MS;
	}
	return SETTLE_WINDOW_IMMEDIATE_MS;
}

/** Higher number = higher priority. Failure beats permission beats review. */
export const EVENT_PRIORITY: Record<AudibleNotificationEventType, number> = {
	review: 0,
	permission: 1,
	failure: 2,
};

export type TaskColumn = "active" | "stopped" | "silent";

export function deriveColumn(summary: RuntimeTaskSessionSummary): TaskColumn {
	if (summary.state === "running") return "active";
	if (summary.state === "interrupted") return "silent";
	if (summary.state === "awaiting_review" && summary.reviewReason === "interrupted") return "silent";
	return "stopped";
}

export function isTabVisible(): boolean {
	if (typeof document === "undefined") {
		return true;
	}
	return document.visibilityState === "visible" && document.hasFocus();
}

export function resolveSessionSoundEvent(summary: RuntimeTaskSessionSummary): AudibleNotificationEventType | null {
	if (summary.state === "awaiting_review") {
		switch (summary.reviewReason) {
			case "hook":
				return isApprovalState(summary) ? "permission" : "review";
			case "attention":
				return "review";
			case "exit":
				return summary.exitCode === 0 ? "review" : "failure";
			case "error":
				return "failure";
			case "interrupted":
				return null;
			default:
				return null;
		}
	}
	if (summary.state === "failed") {
		return "failure";
	}
	return null;
}

export interface AudibleNotificationEventConfig {
	permission: boolean;
	review: boolean;
	failure: boolean;
}

/**
 * Determines whether sounds should be globally suppressed based on
 * the master enable flag and the only-when-hidden preference.
 */
export function areSoundsSuppressed(enabled: boolean, onlyWhenHidden: boolean): boolean {
	return !enabled || (onlyWhenHidden && isTabVisible());
}

/**
 * Determines whether a specific sound event should be suppressed
 * for a task in the current project.
 */
export function isEventSuppressedForProject(
	eventType: AudibleNotificationEventType,
	suppressConfig: AudibleNotificationEventConfig,
	taskWorkspaceId: string | undefined,
	currentProjectId: string | null,
): boolean {
	if (currentProjectId == null) return false;
	return suppressConfig[eventType] && taskWorkspaceId === currentProjectId;
}
