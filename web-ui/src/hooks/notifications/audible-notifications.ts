import { deriveTaskIndicatorState, type RuntimeTaskIndicatorColumn } from "@runtime-contract";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { AudibleNotificationEventType } from "@/utils/notification-audio";

export const SETTLE_WINDOW_HOOK_MS = 500;
export const SETTLE_WINDOW_IMMEDIATE_MS = 0;

export function getSettleWindowMs(summary: RuntimeTaskSessionSummary): number {
	if (deriveTaskIndicatorState(summary).hookReview) {
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

export type TaskColumn = RuntimeTaskIndicatorColumn;

export function deriveColumn(summary: RuntimeTaskSessionSummary): TaskColumn {
	return deriveTaskIndicatorState(summary).column;
}

export function isTabVisible(): boolean {
	if (typeof document === "undefined") {
		return true;
	}
	return document.visibilityState === "visible" && document.hasFocus();
}

export function resolveSessionSoundEvent(summary: RuntimeTaskSessionSummary): AudibleNotificationEventType | null {
	return deriveTaskIndicatorState(summary).notification;
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
 * for a task in the current project. Only suppresses when the tab
 * is visible — if the user isn't looking at the board, the "currently
 * viewed project" concept doesn't apply.
 */
export function isEventSuppressedForProject(
	eventType: AudibleNotificationEventType,
	suppressConfig: AudibleNotificationEventConfig,
	taskWorktreeId: string | undefined,
	currentProjectId: string | null,
): boolean {
	if (!isTabVisible()) return false;
	if (currentProjectId == null) return false;
	return suppressConfig[eventType] && taskWorktreeId === currentProjectId;
}
