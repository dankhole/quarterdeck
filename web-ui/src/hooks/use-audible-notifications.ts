import { useEffect, useRef } from "react";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { type AudibleNotificationEventType, notificationAudioPlayer } from "@/utils/notification-audio";
import { isApprovalState } from "@/utils/session-status";

interface UseAudibleNotificationsOptions {
	activeWorkspaceId: string | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: {
		permission: boolean;
		review: boolean;
		failure: boolean;
		completion: boolean;
	};
	audibleNotificationsOnlyWhenHidden: boolean;
}

/**
 * Settle window in milliseconds. When a task stops (column changes from
 * active → stopped), we wait this long for the session data to stabilise
 * before playing a sound. This covers the gap between the initial state
 * transition (which may lack hook activity data) and the follow-up
 * activity update that arrives after the server's async checkpoint capture.
 */
const SETTLE_WINDOW_MS = 1500;

/** Higher number = higher priority. Failure beats permission beats review/completion. */
const EVENT_PRIORITY: Record<AudibleNotificationEventType, number> = {
	completion: 0,
	review: 0,
	permission: 1,
	failure: 2,
};

type TaskColumn = "active" | "stopped" | "silent";

function deriveColumn(summary: RuntimeTaskSessionSummary): TaskColumn {
	if (summary.state === "running") return "active";
	if (summary.state === "interrupted") return "silent";
	if (summary.state === "awaiting_review" && summary.reviewReason === "interrupted") return "silent";
	// awaiting_review (hook, exit, error, attention) and failed → stopped
	return "stopped";
}

function isTabVisible(): boolean {
	if (typeof document === "undefined") {
		return true;
	}
	return document.visibilityState === "visible";
}

function resolveSessionSoundEvent(summary: RuntimeTaskSessionSummary): AudibleNotificationEventType | null {
	if (summary.state === "awaiting_review") {
		switch (summary.reviewReason) {
			case "hook":
				return isApprovalState(summary) ? "permission" : "review";
			case "attention":
				return "review";
			case "exit":
				return summary.exitCode === 0 ? "completion" : "failure";
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

interface PendingSound {
	eventType: AudibleNotificationEventType;
	timer: ReturnType<typeof setTimeout>;
}

export function useAudibleNotifications({
	activeWorkspaceId,
	taskSessions,
	audibleNotificationsEnabled,
	audibleNotificationVolume,
	audibleNotificationEvents,
	audibleNotificationsOnlyWhenHidden,
}: UseAudibleNotificationsOptions): void {
	const previousColumnsRef = useRef<Map<string, TaskColumn>>(new Map());
	const isInitialLoadRef = useRef(true);
	const previousWorkspaceIdRef = useRef<string | null>(activeWorkspaceId);
	const pendingSoundsRef = useRef<Map<string, PendingSound>>(new Map());
	const latestVolumeRef = useRef(audibleNotificationVolume);
	const latestEventsRef = useRef(audibleNotificationEvents);
	latestVolumeRef.current = audibleNotificationVolume;
	latestEventsRef.current = audibleNotificationEvents;

	const fireSound = (taskId: string) => {
		const pending = pendingSoundsRef.current.get(taskId);
		if (!pending) return;
		pendingSoundsRef.current.delete(taskId);
		if (latestEventsRef.current[pending.eventType]) {
			notificationAudioPlayer.ensureContext();
			notificationAudioPlayer.play(pending.eventType, latestVolumeRef.current);
		}
	};

	// Clear state tracking on workspace switch.
	useEffect(() => {
		if (activeWorkspaceId !== previousWorkspaceIdRef.current) {
			previousColumnsRef.current.clear();
			isInitialLoadRef.current = true;
			for (const pending of pendingSoundsRef.current.values()) {
				clearTimeout(pending.timer);
			}
			pendingSoundsRef.current.clear();
			previousWorkspaceIdRef.current = activeWorkspaceId;
		}
	}, [activeWorkspaceId]);

	// Single detection path: column-based transitions with settle window.
	useEffect(() => {
		if (!activeWorkspaceId) {
			return;
		}

		const previousColumns = previousColumnsRef.current;

		// On initial load, populate columns without playing sounds.
		if (isInitialLoadRef.current) {
			isInitialLoadRef.current = false;
			for (const [taskId, summary] of Object.entries(taskSessions)) {
				previousColumns.set(taskId, deriveColumn(summary));
			}
			return;
		}

		const soundsSuppressed = !audibleNotificationsEnabled || (audibleNotificationsOnlyWhenHidden && isTabVisible());

		for (const [taskId, summary] of Object.entries(taskSessions)) {
			const currentColumn = deriveColumn(summary);
			const previousColumn = previousColumns.get(taskId);
			previousColumns.set(taskId, currentColumn);

			if (soundsSuppressed) {
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
					const timer = setTimeout(() => fireSound(taskId), SETTLE_WINDOW_MS);
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

		// Clean up removed tasks.
		for (const taskId of previousColumns.keys()) {
			if (!(taskId in taskSessions)) {
				previousColumns.delete(taskId);
				const existing = pendingSoundsRef.current.get(taskId);
				if (existing) {
					clearTimeout(existing.timer);
					pendingSoundsRef.current.delete(taskId);
				}
			}
		}
	}, [activeWorkspaceId, audibleNotificationsEnabled, audibleNotificationsOnlyWhenHidden, taskSessions]);

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
