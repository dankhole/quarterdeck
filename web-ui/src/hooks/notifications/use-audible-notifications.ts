import { useEffect, useMemo, useRef } from "react";
import {
	type AudibleNotificationEventConfig,
	type AudibleTaskNotificationState,
	areSoundsSuppressed,
	deriveAudibleTaskNotificationState,
	deriveColumn,
	EVENT_PRIORITY,
	getSettleWindowMs,
	isEventSuppressedForProject,
	isNewAudibleNotification,
} from "@/hooks/notifications/audible-notifications";
import { flattenProjectNotificationTasks } from "@/hooks/notifications/project-notifications";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import type { AudibleNotificationEventType } from "@/utils/notification-audio";
import { notificationAudioPlayer } from "@/utils/notification-audio";

interface UseAudibleNotificationsOptions {
	notificationProjects: RuntimeProjectNotificationStateMap;
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: AudibleNotificationEventConfig;
	audibleNotificationsOnlyWhenHidden: boolean;
	/** Per-event suppression for tasks in the currently viewed project. */
	audibleNotificationSuppressCurrentProject: AudibleNotificationEventConfig;
	/** The currently viewed project ID. */
	currentProjectId: string | null;
	/** Task IDs for which sounds should be suppressed immediately, such as locally trashed tasks. */
	suppressedTaskIds?: ReadonlySet<string>;
}

interface PendingSound {
	eventType: AudibleNotificationEventType;
	timer: ReturnType<typeof setTimeout>;
}

export function useAudibleNotifications({
	notificationProjects,
	audibleNotificationsEnabled,
	audibleNotificationVolume,
	audibleNotificationEvents,
	audibleNotificationsOnlyWhenHidden,
	audibleNotificationSuppressCurrentProject,
	currentProjectId,
	suppressedTaskIds,
}: UseAudibleNotificationsOptions): void {
	const notificationTasks = useMemo(
		() => flattenProjectNotificationTasks(notificationProjects),
		[notificationProjects],
	);
	const previousStatesRef = useRef<Map<string, AudibleTaskNotificationState>>(new Map());
	const isInitialLoadRef = useRef(true);
	const pendingSoundsRef = useRef<Map<string, PendingSound>>(new Map());
	const latestVolumeRef = useRef(audibleNotificationVolume);
	const latestEventsRef = useRef(audibleNotificationEvents);
	const latestSuppressRef = useRef(audibleNotificationSuppressCurrentProject);
	const latestNotificationTasksRef = useRef(notificationTasks);
	const latestProjectIdRef = useRef(currentProjectId);
	const latestSuppressedTaskIdsRef = useRef(suppressedTaskIds);
	latestVolumeRef.current = audibleNotificationVolume;
	latestEventsRef.current = audibleNotificationEvents;
	latestSuppressRef.current = audibleNotificationSuppressCurrentProject;
	latestNotificationTasksRef.current = notificationTasks;
	latestProjectIdRef.current = currentProjectId;
	latestSuppressedTaskIdsRef.current = suppressedTaskIds;

	const cancelPendingSound = (taskId: string) => {
		const existing = pendingSoundsRef.current.get(taskId);
		if (!existing) {
			return;
		}
		clearTimeout(existing.timer);
		pendingSoundsRef.current.delete(taskId);
	};

	const fireSound = (taskId: string) => {
		const pending = pendingSoundsRef.current.get(taskId);
		if (!pending) return;
		pendingSoundsRef.current.delete(taskId);
		const task = latestNotificationTasksRef.current[taskId];
		if (!task || latestSuppressedTaskIdsRef.current?.has(taskId) || deriveColumn(task.summary) !== "stopped") {
			return;
		}
		const eventType = pending.eventType;
		if (!latestEventsRef.current[eventType]) return;
		if (
			isEventSuppressedForProject(eventType, latestSuppressRef.current, task.projectId, latestProjectIdRef.current)
		) {
			return;
		}
		notificationAudioPlayer.ensureContext();
		notificationAudioPlayer.play(eventType, latestVolumeRef.current);
	};

	// Single detection path: semantic notification edges with a settle window.
	useEffect(() => {
		const previousStates = previousStatesRef.current;

		// On initial load, populate state without playing sounds.
		if (isInitialLoadRef.current) {
			isInitialLoadRef.current = false;
			for (const [taskId, task] of Object.entries(notificationTasks)) {
				previousStates.set(taskId, deriveAudibleTaskNotificationState(task.summary));
			}
			return;
		}

		const soundsSuppressed = areSoundsSuppressed(audibleNotificationsEnabled, audibleNotificationsOnlyWhenHidden);

		for (const [taskId, task] of Object.entries(notificationTasks)) {
			const currentState = deriveAudibleTaskNotificationState(task.summary);
			const previousState = previousStates.get(taskId);
			previousStates.set(taskId, currentState);

			// Newly discovered tasks are seeded silently, matching initial-load
			// behavior and avoiding alerts for retained historical state.
			if (!previousState) {
				continue;
			}

			if (soundsSuppressed || suppressedTaskIds?.has(taskId)) {
				cancelPendingSound(taskId);
				continue;
			}

			if (currentState.column !== "stopped") {
				cancelPendingSound(taskId);
				continue;
			}

			// A task is still stopped and we have a pending sound —
			// session data is refining (e.g. hook activity arrived). Upgrade
			// the pending sound if the new event is higher priority.
			if (pendingSoundsRef.current.has(taskId)) {
				const pending = pendingSoundsRef.current.get(taskId)!;
				const eventType = currentState.eventType;
				if (eventType && EVENT_PRIORITY[eventType] > EVENT_PRIORITY[pending.eventType]) {
					pending.eventType = eventType;
				}
				continue;
			}

			if (isNewAudibleNotification(previousState, currentState) && currentState.eventType) {
				const timer = setTimeout(() => fireSound(taskId), getSettleWindowMs(task.summary));
				pendingSoundsRef.current.set(taskId, { eventType: currentState.eventType, timer });
			}
		}

		// Clean up removed tasks. In practice notification state grows monotonically,
		// so this loop is defensive — retained for correctness if pruning is added later.
		for (const taskId of previousStates.keys()) {
			if (!(taskId in notificationTasks)) {
				previousStates.delete(taskId);
				cancelPendingSound(taskId);
			}
		}
	}, [audibleNotificationsEnabled, audibleNotificationsOnlyWhenHidden, notificationTasks, suppressedTaskIds]);

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
