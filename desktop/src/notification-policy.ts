import type { RuntimeNotificationPreferences } from "../../src/core/api/notification-presentation.js";
import { deriveTaskIndicatorState, type RuntimeTaskIndicatorNotification } from "../../src/core/api/task-indicators.js";
import type { RuntimeTaskSessionSummary } from "../../src/core/api/task-session.js";
import {
	deriveTaskNotificationState,
	getTaskNotificationSettleWindowMs,
	isNewTaskNotification,
	TASK_NOTIFICATION_EVENT_PRIORITY,
	taskNotificationEventIdentity,
} from "../../src/shared/task-notification-policy.js";

export interface DesktopNotificationFocus {
	focused: boolean;
	currentProjectId: string | null;
}
export interface DesktopTaskNotification {
	eventId: string;
	projectId: string;
	taskId: string;
	eventType: RuntimeTaskIndicatorNotification;
}
interface PendingNotification {
	projectId: string;
	taskId: string;
	eventType: RuntimeTaskIndicatorNotification;
	dueAt: number;
}
const MAX_SEEN_EVENTS = 2_048;

/** Native presentation consumes the same authoritative indicator edges as browser audio. */
export class DesktopNotificationPolicy {
	private readonly sessions = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	private readonly revisions = new Map<string, number>();
	private readonly pending = new Map<string, PendingNotification>();
	private readonly seen = new Set<string>();
	private owned = false;

	setOwned(owned: boolean): void {
		if (this.owned !== owned) this.pending.clear();
		this.owned = owned;
	}

	seed(
		projectIds: readonly string[],
		summaries: Readonly<Record<string, readonly RuntimeTaskSessionSummary[]>>,
		revisions: Readonly<Record<string, number>>,
	): void {
		this.pending.clear();
		this.sessions.clear();
		this.revisions.clear();
		for (const projectId of projectIds) {
			this.sessions.set(
				projectId,
				new Map((summaries[projectId] ?? []).map((summary) => [summary.taskId, summary])),
			);
			this.revisions.set(projectId, revisions[projectId] ?? 0);
		}
	}

	pruneProjects(projectIds: readonly string[]): void {
		const retained = new Set(projectIds);
		for (const projectId of this.sessions.keys())
			if (!retained.has(projectId)) {
				this.sessions.delete(projectId);
				this.revisions.delete(projectId);
			}
		for (const [key, event] of this.pending) if (!retained.has(event.projectId)) this.pending.delete(key);
	}

	applyDelta(
		projectId: string,
		revision: number,
		summaries: readonly RuntimeTaskSessionSummary[],
		removedTaskIds: readonly string[],
		replace: boolean,
		now: number,
	): void {
		if (revision < (this.revisions.get(projectId) ?? 0)) return;
		this.revisions.set(projectId, revision);
		const current = this.sessions.get(projectId) ?? new Map<string, RuntimeTaskSessionSummary>();
		const retained = new Set(summaries.map((summary) => summary.taskId));
		for (const taskId of current.keys())
			if (removedTaskIds.includes(taskId) || (replace && !retained.has(taskId))) {
				current.delete(taskId);
				this.pending.delete(JSON.stringify([projectId, taskId]));
			}
		for (const summary of summaries) {
			const previous = current.get(summary.taskId);
			current.set(summary.taskId, summary);
			const key = JSON.stringify([projectId, summary.taskId]);
			const state = deriveTaskNotificationState(summary);
			if (!this.owned || state.column !== "stopped" || !state.eventType) {
				this.pending.delete(key);
				continue;
			}
			const pending = this.pending.get(key);
			if (pending) {
				if (TASK_NOTIFICATION_EVENT_PRIORITY[state.eventType] > TASK_NOTIFICATION_EVENT_PRIORITY[pending.eventType])
					pending.eventType = state.eventType;
			} else if (previous && isNewTaskNotification(deriveTaskNotificationState(previous), state)) {
				this.pending.set(key, {
					projectId,
					taskId: summary.taskId,
					eventType: state.eventType,
					dueAt: now + getTaskNotificationSettleWindowMs(summary),
				});
			}
		}
		this.sessions.set(projectId, current);
	}

	flush(
		now: number,
		preferences: RuntimeNotificationPreferences | null,
		focus: DesktopNotificationFocus,
	): DesktopTaskNotification[] {
		const events: DesktopTaskNotification[] = [];
		for (const [key, pending] of this.pending) {
			if (pending.dueAt > now) continue;
			this.pending.delete(key);
			const summary = this.sessions.get(pending.projectId)?.get(pending.taskId);
			if (!summary || !this.owned) continue;
			const indicator = deriveTaskIndicatorState(summary);
			if (indicator.column !== "stopped" || indicator.notification !== pending.eventType) continue;
			const eventId = taskNotificationEventIdentity(pending.projectId, summary, pending.eventType);
			if (this.seen.has(eventId)) continue;
			this.seen.add(eventId);
			while (this.seen.size > MAX_SEEN_EVENTS) {
				const oldest = this.seen.values().next().value;
				if (oldest !== undefined) this.seen.delete(oldest);
			}
			if (
				!preferences?.enabled ||
				!preferences.events[pending.eventType] ||
				(preferences.onlyWhenHidden && focus.focused) ||
				(focus.focused &&
					pending.projectId === focus.currentProjectId &&
					preferences.suppressCurrentProject[pending.eventType])
			)
				continue;
			events.push({ eventId, projectId: pending.projectId, taskId: pending.taskId, eventType: pending.eventType });
		}
		return events;
	}

	nextDeadline(): number | null {
		let earliest: number | null = null;
		for (const pending of this.pending.values())
			if (earliest === null || pending.dueAt < earliest) earliest = pending.dueAt;
		return earliest;
	}
	badgeCount(): number {
		if (!this.owned) return 0;
		let count = 0;
		for (const project of this.sessions.values())
			for (const summary of project.values()) if (deriveTaskIndicatorState(summary).notification) count++;
		return count;
	}
	resolveTarget(projectId: string, taskId: string): { projectId: string | null; taskId: string | null } {
		const project = this.sessions.get(projectId);
		return { projectId: project ? projectId : null, taskId: project?.has(taskId) ? taskId : null };
	}
}
