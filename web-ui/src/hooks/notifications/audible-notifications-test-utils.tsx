import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

import { useAudibleNotifications } from "@/hooks/notifications/use-audible-notifications";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function createMockSession(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: "claude",
		sessionLaunchPath: "/tmp/repo",
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

export interface HookProps {
	notificationProjects?: RuntimeProjectNotificationStateMap;
	notificationSessions?: Record<string, RuntimeTaskSessionSummary>;
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: {
		permission: boolean;
		review: boolean;
		failure: boolean;
	};
	audibleNotificationsOnlyWhenHidden: boolean;
	audibleNotificationSuppressCurrentProject: {
		permission: boolean;
		review: boolean;
		failure: boolean;
	};
	notificationProjectIds?: Record<string, string>;
	currentProjectId: string | null;
}

export function defaultProps(): HookProps {
	return {
		notificationProjects: {},
		audibleNotificationsEnabled: true,
		audibleNotificationVolume: 0.7,
		audibleNotificationEvents: {
			permission: true,
			review: true,
			failure: true,
		},
		audibleNotificationsOnlyWhenHidden: true,
		audibleNotificationSuppressCurrentProject: {
			permission: false,
			review: false,
			failure: false,
		},
		currentProjectId: null,
	};
}

export function HookHarness({ onRender, ...props }: HookProps & { onRender?: () => void }): null {
	const notificationProjects =
		props.notificationSessions || props.notificationProjectIds
			? buildNotificationProjectsFromLegacyProps(props)
			: (props.notificationProjects ?? {});

	useAudibleNotifications({
		notificationProjects,
		audibleNotificationsEnabled: props.audibleNotificationsEnabled,
		audibleNotificationVolume: props.audibleNotificationVolume,
		audibleNotificationEvents: props.audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden: props.audibleNotificationsOnlyWhenHidden,
		audibleNotificationSuppressCurrentProject: props.audibleNotificationSuppressCurrentProject,
		currentProjectId: props.currentProjectId,
	});
	useEffect(() => {
		onRender?.();
	});
	return null;
}

function buildNotificationProjectsFromLegacyProps(props: HookProps): RuntimeProjectNotificationStateMap {
	const notificationProjects: RuntimeProjectNotificationStateMap = {};
	for (const [taskId, summary] of Object.entries(props.notificationSessions ?? {})) {
		const projectId = props.notificationProjectIds?.[taskId] ?? props.currentProjectId ?? "project-unknown";
		const project = notificationProjects[projectId] ?? { sessions: {} };
		project.sessions[taskId] = summary;
		notificationProjects[projectId] = project;
	}
	return notificationProjects;
}

/** Must match SETTLE_WINDOW_HOOK_MS in source. */
export const SETTLE_HOOK_MS = 500;

export interface TestHarness {
	root: Root;
	container: HTMLDivElement;
	flushSettleWindow: () => void;
	cleanup: () => void;
}

export function setupTestHarness(): TestHarness {
	vi.useFakeTimers();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
	vi.spyOn(document, "hasFocus").mockReturnValue(false);

	const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);

	function flushSettleWindow(): void {
		act(() => {
			vi.advanceTimersByTime(SETTLE_HOOK_MS + 50);
		});
	}

	function cleanup(): void {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	}

	return { root, container, flushSettleWindow, cleanup };
}
