import { useEffect, useRef } from "react";
import {
	type AudibleNotificationEventConfig,
	areSoundsSuppressed,
	deriveColumn,
	EVENT_PRIORITY,
	getSettleWindowMs,
	isEventSuppressedForProject,
	resolveSessionSoundEvent,
	type TaskColumn,
} from "@/hooks/notifications/audible-notifications";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { AudibleNotificationEventType } from "@/utils/notification-audio";
import { notificationAudioPlayer } from "@/utils/notification-audio";

interface UseAudibleNotificationsOptions {
	notificationSessions: Record<string, RuntimeTaskSessionSummary>;
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: AudibleNotificationEventConfig;
	audibleNotificationsOnlyWhenHidden: boolean;
	/** Per-event suppression for tasks in the currently viewed project. */
	audibleNotificationSuppressCurrentProject: AudibleNotificationEventConfig;
	/** Maps task IDs to their workspace/project IDs. */
	notificationWorkspaceIds: Record<string, string>;
	/** The currently viewed project ID. */
	currentProjectId: string | null;
	/** Task IDs for which sounds should be suppressed (e.g. tasks being trashed). */
	suppressedTaskIds?: ReadonlySet<string>;
}

interface PendingSound {
	eventType: AudibleNotificationEventType;
	timer: ReturnType<typeof setTimeout>;
}

export function useAudibleNotifications({
	notificationSessions,
	audibleNotificationsEnabled,
	audibleNotificationVolume,
	audibleNotificationEvents,
	audibleNotificationsOnlyWhenHidden,
	audibleNotificationSuppressCurrentProject,
	notificationWorkspaceIds,
	currentProjectId,
	suppressedTaskIds,
}: UseAudibleNotificationsOptions): void {
	const previousColumnsRef = useRef<Map<string, TaskColumn>>(new Map());
	const isInitialLoadRef = useRef(true);
	const pendingSoundsRef = useRef<Map<string, PendingSound>>(new Map());
	const latestVolumeRef = useRef(audibleNotificationVolume);
	const latestEventsRef = useRef(audibleNotificationEvents);
	const latestSuppressRef = useRef(audibleNotificationSuppressCurrentProject);
	const latestWorkspaceIdsRef = useRef(notificationWorkspaceIds);
	const latestProjectIdRef = useRef(currentProjectId);
	latestVolumeRef.current = audibleNotificationVolume;
	latestEventsRef.current = audibleNotificationEvents;
	latestSuppressRef.current = audibleNotificationSuppressCurrentProject;
	latestWorkspaceIdsRef.current = notificationWorkspaceIds;
	latestProjectIdRef.current = currentProjectId;

	const fireSound = (taskId: string) => {
		const pending = pendingSoundsRef.current.get(taskId);
		if (!pending) return;
		pendingSoundsRef.current.delete(taskId);
		const eventType = pending.eventType;
		if (!latestEventsRef.current[eventType]) return;
		if (
			isEventSuppressedForProject(
				eventType,
				latestSuppressRef.current,
				latestWorkspaceIdsRef.current[taskId],
				latestProjectIdRef.current,
			)
		) {
			return;
		}
		notificationAudioPlayer.ensureContext();
		notificationAudioPlayer.play(eventType, latestVolumeRef.current);
	};

	// Single detection path: column-based transitions with settle window.
	useEffect(() => {
		const previousColumns = previousColumnsRef.current;

		// On initial load, populate columns without playing sounds.
		if (isInitialLoadRef.current) {
			isInitialLoadRef.current = false;
			for (const [taskId, summary] of Object.entries(notificationSessions)) {
				previousColumns.set(taskId, deriveColumn(summary));
			}
			return;
		}

		const soundsSuppressed = areSoundsSuppressed(audibleNotificationsEnabled, audibleNotificationsOnlyWhenHidden);

		for (const [taskId, summary] of Object.entries(notificationSessions)) {
			const currentColumn = deriveColumn(summary);
			const previousColumn = previousColumns.get(taskId);
			previousColumns.set(taskId, currentColumn);

			if (soundsSuppressed || suppressedTaskIds?.has(taskId)) {
				const existing = pendingSoundsRef.current.get(taskId);
				if (existing) {
					clearTimeout(existing.timer);
					pendingSoundsRef.current.delete(taskId);
				}
				continue;
			}

			// Case 1: Task just transitioned from active → stopped.
			// Open a settle window and record the initial sound event.
			if (previousColumn === "active" && currentColumn === "stopped") {
				// Cancel any existing pending sound (shouldn't happen, but defensive).
				const existing = pendingSoundsRef.current.get(taskId);
				if (existing) {
					clearTimeout(existing.timer);
				}
				const eventType = resolveSessionSoundEvent(summary);
				if (eventType) {
					const timer = setTimeout(() => fireSound(taskId), getSettleWindowMs(summary));
					pendingSoundsRef.current.set(taskId, { eventType, timer });
				}
				continue;
			}

			// Case 2: Task is still stopped and we have a pending sound —
			// session data is refining (e.g. hook activity arrived). Upgrade
			// the pending sound if the new event is higher priority.
			if (currentColumn === "stopped" && pendingSoundsRef.current.has(taskId)) {
				const pending = pendingSoundsRef.current.get(taskId)!;
				const eventType = resolveSessionSoundEvent(summary);
				if (eventType && EVENT_PRIORITY[eventType] > EVENT_PRIORITY[pending.eventType]) {
					pending.eventType = eventType;
				}
				continue;
			}

			// Case 3: Task went back to active (resumed) — cancel pending sound.
			if (currentColumn === "active") {
				const existing = pendingSoundsRef.current.get(taskId);
				if (existing) {
					clearTimeout(existing.timer);
					pendingSoundsRef.current.delete(taskId);
				}
			}
		}

		// Clean up removed tasks. In practice notificationSessions grows monotonically,
		// so this loop is defensive — retained for correctness if pruning is added later.
		for (const taskId of previousColumns.keys()) {
			if (!(taskId in notificationSessions)) {
				previousColumns.delete(taskId);
				const existing = pendingSoundsRef.current.get(taskId);
				if (existing) {
					clearTimeout(existing.timer);
					pendingSoundsRef.current.delete(taskId);
				}
			}
		}
	}, [audibleNotificationsEnabled, audibleNotificationsOnlyWhenHidden, notificationSessions, suppressedTaskIds]);

	// Clean up pending timers on unmount.
	useEffect(() => {
		return () => {
			for (const pending of pendingSoundsRef.current.values()) {
				clearTimeout(pending.timer);
			}
			pendingSoundsRef.current.clear();
		};
	}, []);

	// One-time click listener to unlock AudioContext via user gesture.
	useEffect(() => {
		const handler = () => {
			notificationAudioPlayer.ensureContext();
			document.removeEventListener("click", handler);
		};
		document.addEventListener("click", handler);
		return () => {
			document.removeEventListener("click", handler);
		};
	}, []);
}
