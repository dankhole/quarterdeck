import {
	deriveTaskIndicatorState,
	type RuntimeTaskIndicatorColumn,
	type RuntimeTaskIndicatorNotification,
} from "../core/api/task-indicators.js";
import type { RuntimeTaskSessionSummary } from "../core/api/task-session.js";

export const TASK_NOTIFICATION_EVENT_PRIORITY: Record<RuntimeTaskIndicatorNotification, number> = {
	review: 0,
	permission: 1,
	failure: 2,
};
export interface TaskNotificationState {
	column: RuntimeTaskIndicatorColumn;
	eventType: RuntimeTaskIndicatorNotification | null;
}

export function deriveTaskNotificationState(summary: RuntimeTaskSessionSummary): TaskNotificationState {
	const indicator = deriveTaskIndicatorState(summary);
	return { column: indicator.column, eventType: indicator.notification };
}

/** Shared semantic edges; no terminal output or browser optimistic state contributes. */
export function isNewTaskNotification(previous: TaskNotificationState, current: TaskNotificationState): boolean {
	if (current.column !== "stopped" || current.eventType === null) return false;
	return (
		previous.column === "active" ||
		previous.eventType === null ||
		TASK_NOTIFICATION_EVENT_PRIORITY[current.eventType] > TASK_NOTIFICATION_EVENT_PRIORITY[previous.eventType]
	);
}

export function getTaskNotificationSettleWindowMs(summary: RuntimeTaskSessionSummary): number {
	return deriveTaskIndicatorState(summary).hookReview ? 500 : 0;
}

/** Stable provider/session evidence survives replay; raw titles, prompts and output stay out of identity. */
export function taskNotificationEventIdentity(
	projectId: string,
	summary: RuntimeTaskSessionSummary,
	eventType: RuntimeTaskIndicatorNotification,
): string {
	const interaction = summary.outstandingInteraction;
	return JSON.stringify([
		projectId,
		summary.taskId,
		summary.sessionInstanceId ?? summary.startedAt,
		eventType,
		interaction
			? [
					interaction.sessionInstanceId,
					interaction.toolUseId,
					interaction.promptId,
					interaction.elicitationId,
					interaction.openedAt,
				]
			: [summary.reviewReason, summary.lastProviderHookOccurredAt ?? summary.lastHookAt ?? summary.updatedAt],
	]);
}
