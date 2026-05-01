import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

import { useAudibleNotifications } from "@/hooks/notifications/use-audible-notifications";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	createTestAudibleNotificationConfig,
	type TestAudibleNotificationConfig,
} from "@/test-utils/runtime-config-factory";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";

export function createMockSession(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		agentId: "claude",
		sessionLaunchPath: "/tmp/repo",
		updatedAt: Date.now(),
		...overrides,
	});
}

export interface HookProps extends TestAudibleNotificationConfig {
	notificationProjects?: RuntimeProjectNotificationStateMap;
	notificationSessions?: Record<string, RuntimeTaskSessionSummary>;
	notificationProjectIds?: Record<string, string>;
	currentProjectId: string | null;
	suppressedTaskIds?: ReadonlySet<string>;
}

type HookPropsOverrides = Omit<
	Partial<HookProps>,
	"audibleNotificationEvents" | "audibleNotificationSuppressCurrentProject"
> & {
	audibleNotificationEvents?: Partial<HookProps["audibleNotificationEvents"]>;
	audibleNotificationSuppressCurrentProject?: Partial<HookProps["audibleNotificationSuppressCurrentProject"]>;
};

export function defaultProps(overrides: HookPropsOverrides = {}): HookProps {
	const config = createTestAudibleNotificationConfig({
		audibleNotificationsEnabled: overrides.audibleNotificationsEnabled,
		audibleNotificationVolume: overrides.audibleNotificationVolume,
		audibleNotificationEvents: overrides.audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden: overrides.audibleNotificationsOnlyWhenHidden,
		audibleNotificationSuppressCurrentProject: {
			permission: false,
			review: false,
			failure: false,
			...overrides.audibleNotificationSuppressCurrentProject,
		},
	});

	return {
		notificationProjects: overrides.notificationProjects ?? {},
		notificationSessions: overrides.notificationSessions,
		notificationProjectIds: overrides.notificationProjectIds,
		currentProjectId: overrides.currentProjectId ?? null,
		...config,
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
		suppressedTaskIds: props.suppressedTaskIds,
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
