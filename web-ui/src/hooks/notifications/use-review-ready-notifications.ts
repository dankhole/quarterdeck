import { useEffect, useMemo, useRef, useState } from "react";
import { useDocumentVisibility } from "@/hooks/notifications/use-document-visibility";
import type { RuntimeStateStreamTaskReadyForReviewMessage } from "@/runtime/types";
import { useDocumentTitle, useWindowEvent } from "@/utils/react-use";

interface UseReviewReadyNotificationsOptions {
	activeProjectId: string | null;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	projectPath: string | null;
}

const MAX_HANDLED_READY_EVENT_KEYS = 200;

export function useReviewReadyNotifications({
	activeProjectId,
	latestTaskReadyForReview,
	projectPath,
}: UseReviewReadyNotificationsOptions): void {
	const handledReadyForReviewEventKeysRef = useRef<Set<string>>(new Set());
	const handledReadyForReviewEventKeyQueueRef = useRef<string[]>([]);
	const [pendingReviewReadyNotificationCount, setPendingReviewReadyNotificationCount] = useState(0);
	const [isWindowFocused, setIsWindowFocused] = useState(() => {
		if (typeof document === "undefined") {
			return true;
		}
		return document.hasFocus();
	});
	const isDocumentVisible = useDocumentVisibility();
	const projectTitle = useMemo(() => {
		if (!projectPath) {
			return null;
		}
		const segments = projectPath
			.replaceAll("\\", "/")
			.split("/")
			.filter((segment) => segment.length > 0);
		if (segments.length === 0) {
			return projectPath;
		}
		return segments[segments.length - 1] ?? projectPath;
	}, [projectPath]);
	const isAppActive = isDocumentVisible && isWindowFocused;

	useWindowEvent("focus", () => {
		setIsWindowFocused(true);
	});
	useWindowEvent("blur", () => {
		setIsWindowFocused(false);
	});

	// Clear badge count when the app becomes active (user is looking at it).
	useEffect(() => {
		if (isAppActive) {
			setPendingReviewReadyNotificationCount(0);
		}
	}, [isAppActive]);

	// Track review-ready events and increment badge count when backgrounded.
	useEffect(() => {
		if (!latestTaskReadyForReview) {
			return;
		}
		if (!activeProjectId || latestTaskReadyForReview.projectId !== activeProjectId) {
			return;
		}
		const eventKey = `${latestTaskReadyForReview.projectId}:${latestTaskReadyForReview.taskId}:${latestTaskReadyForReview.triggeredAt}`;
		if (handledReadyForReviewEventKeysRef.current.has(eventKey)) {
			return;
		}
		handledReadyForReviewEventKeysRef.current.add(eventKey);
		handledReadyForReviewEventKeyQueueRef.current.push(eventKey);
		if (handledReadyForReviewEventKeyQueueRef.current.length > MAX_HANDLED_READY_EVENT_KEYS) {
			const oldestKey = handledReadyForReviewEventKeyQueueRef.current.shift();
			if (oldestKey) {
				handledReadyForReviewEventKeysRef.current.delete(oldestKey);
			}
		}

		const isVisibleNow = typeof document !== "undefined" ? document.visibilityState === "visible" : true;
		const isWindowFocusedNow = typeof document !== "undefined" ? document.hasFocus() : true;
		if (isVisibleNow && isWindowFocusedNow) {
			return;
		}
		setPendingReviewReadyNotificationCount((current) => current + 1);
	}, [activeProjectId, latestTaskReadyForReview]);

	// Reset dedup state on project switch.
	useEffect(() => {
		handledReadyForReviewEventKeysRef.current.clear();
		handledReadyForReviewEventKeyQueueRef.current = [];
		setPendingReviewReadyNotificationCount(0);
	}, [activeProjectId]);

	const baseTitle = projectTitle || "quarterdeck";
	const documentTitle =
		pendingReviewReadyNotificationCount > 0 ? `(${pendingReviewReadyNotificationCount}) ${baseTitle}` : baseTitle;
	useDocumentTitle(documentTitle);
}
