import { useEffect, useRef } from "react";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { type AudibleNotificationEventType, notificationAudioPlayer } from "@/utils/notification-audio";
import { isApprovalState } from "@/utils/session-status";

interface UseAudibleNotificationsOptions {
	notificationSessions: Record<string, RuntimeTaskSessionSummary>;
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: {
		permission: boolean;
		review: boolean;
		failure: boolean;
		completion: boolean;
	};
	audibleNotificationsOnlyWhenHidden: boolean;
	/** Task IDs for which sounds should be suppressed (e.g. tasks being trashed). */
	suppressedTaskIds?: ReadonlySet<string>;
}

/**
 * Settle window for hook-based transitions. When a hook fires `to_review`,
 * `latestHookActivity` is cleared and repopulated after the server's async
 * checkpoint capture. This window allows the activity data to arrive so
 * `isApprovalState` can distinguish permission sounds from review sounds.
 *
 * Non-hook transitions (exit, error, attention, failed) have their sound
 * event fully determined by `state`, `reviewReason`, and `exitCode` — they
 * fire immediately with no settle delay.
 */
const SETTLE_WINDOW_HOOK_MS = 500;
const SETTLE_WINDOW_IMMEDIATE_MS = 0;

function getSettleWindowMs(summary: RuntimeTaskSessionSummary): number {
	if (summary.state === "awaiting_review" && summary.reviewReason === "hook") {
		return SETTLE_WINDOW_HOOK_MS;
	}
	return SETTLE_WINDOW_IMMEDIATE_MS;
}

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
	// Both conditions must be true for the user to actually be looking at
	// Quarterdeck. visibilityState alone reports "visible" even when the
	// browser window is behind other apps (terminal, IDE), which is the
	// primary use case for audible notifications.
	return document.visibilityState === "visible" && document.hasFocus();
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
	notificationSessions,
	audibleNotificationsEnabled,
	audibleNotificationVolume,
	audibleNotificationEvents,
	audibleNotificationsOnlyWhenHidden,
	suppressedTaskIds,
}: UseAudibleNotificationsOptions): void {
	const previousColumnsRef = useRef<Map<string, TaskColumn>>(new Map());
	const isInitialLoadRef = useRef(true);
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

		const soundsSuppressed = !audibleNotificationsEnabled || (audibleNotificationsOnlyWhenHidden && isTabVisible());

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
