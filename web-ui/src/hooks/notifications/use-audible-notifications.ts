import { useEffect, useMemo, useRef } from "react";
import {
	type AudibleNotificationEventConfig,
	type AudibleTaskNotificationState,
	areSoundsSuppressed,
	deriveAudibleTaskNotificationState,
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

function isTaskLocallySuppressed(
	task: { projectId: string; taskId: string } | undefined,
	currentProjectId: string | null,
	suppressedTaskIds: ReadonlySet<string> | undefined,
): boolean {
	return (
		task !== undefined &&
		suppressedTaskIds?.has(task.taskId) === true &&
		(currentProjectId === null || task.projectId === currentProjectId)
	);
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

	const cancelPendingSound = (notificationKey: string) => {
		const existing = pendingSoundsRef.current.get(notificationKey);
		if (!existing) {
			return;
		}
		clearTimeout(existing.timer);
		pendingSoundsRef.current.delete(notificationKey);
	};

	const fireSound = (notificationKey: string) => {
		const pending = pendingSoundsRef.current.get(notificationKey);
		if (!pending) return;
		pendingSoundsRef.current.delete(notificationKey);
		const task = latestNotificationTasksRef.current[notificationKey];
		const locallySuppressed = isTaskLocallySuppressed(
			task,
			latestProjectIdRef.current,
			latestSuppressedTaskIdsRef.current,
		);
		if (!task || locallySuppressed) {
			return;
		}
		const currentState = deriveAudibleTaskNotificationState(task.summary);
		if (currentState.column !== "stopped" || currentState.eventType === null) {
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
		void notificationAudioPlayer
			.play(eventType, latestVolumeRef.current, {
				projectId: task.projectId,
				taskId: task.taskId,
			})
			.catch((error: unknown) => {
				console.warn(
					`[host-integration] Could not complete notification audio: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
	};

	// Single detection path: semantic notification edges with a settle window.
	useEffect(() => {
		const previousStates = previousStatesRef.current;

		// On initial load, populate state without playing sounds.
		if (isInitialLoadRef.current) {
			isInitialLoadRef.current = false;
			for (const [notificationKey, task] of Object.entries(notificationTasks)) {
				previousStates.set(notificationKey, deriveAudibleTaskNotificationState(task.summary));
			}
			return;
		}

		const soundsSuppressed = areSoundsSuppressed(audibleNotificationsEnabled, audibleNotificationsOnlyWhenHidden);

		for (const [notificationKey, task] of Object.entries(notificationTasks)) {
			const currentState = deriveAudibleTaskNotificationState(task.summary);
			const previousState = previousStates.get(notificationKey);
			previousStates.set(notificationKey, currentState);

			// Newly discovered tasks are seeded silently, matching initial-load
			// behavior and avoiding alerts for retained historical state.
			if (!previousState) {
				continue;
			}

			const locallySuppressed = isTaskLocallySuppressed(task, currentProjectId, suppressedTaskIds);
			if (soundsSuppressed || locallySuppressed) {
				cancelPendingSound(notificationKey);
				continue;
			}

			if (currentState.column !== "stopped" || currentState.eventType === null) {
				cancelPendingSound(notificationKey);
				continue;
			}

			// A task is still stopped and we have a pending sound —
			// session data is refining (e.g. hook activity arrived). Upgrade
			// the pending sound if the new event is higher priority.
			if (pendingSoundsRef.current.has(notificationKey)) {
				const pending = pendingSoundsRef.current.get(notificationKey)!;
				const eventType = currentState.eventType;
				if (eventType && EVENT_PRIORITY[eventType] > EVENT_PRIORITY[pending.eventType]) {
					pending.eventType = eventType;
				}
				continue;
			}

			if (isNewAudibleNotification(previousState, currentState) && currentState.eventType) {
				const timer = setTimeout(() => fireSound(notificationKey), getSettleWindowMs(task.summary));
				pendingSoundsRef.current.set(notificationKey, { eventType: currentState.eventType, timer });
			}
		}

		// Clean up removed tasks. In practice notification state grows monotonically,
		// so this loop is defensive — retained for correctness if pruning is added later.
		for (const notificationKey of previousStates.keys()) {
			if (!(notificationKey in notificationTasks)) {
				previousStates.delete(notificationKey);
				cancelPendingSound(notificationKey);
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
