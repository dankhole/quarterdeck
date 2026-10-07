import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { showAppToast } from "@/components/app-toaster";
import { getDesktopFileEditorRecoveryCommitStatus } from "@/hooks/git/desktop-file-editor-recovery";
import {
	getFileEditorDrafts,
	setFileEditorReviewTarget,
	subscribeFileEditorCache,
} from "@/hooks/git/file-editor-cache";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import {
	type DesktopNotificationTarget,
	desktopNotificationTargetSchema,
	desktopProjectOpenRequestSchema,
	desktopQuitPreflightRequestSchema,
} from "../../../../src/shared/desktop-bridge-contract";
import {
	type DesktopAppHandlers,
	type DesktopNotificationNavigationContext,
	deriveAppCommandAvailability,
	deriveDesktopFrontendStatus,
	dispatchDesktopAppCommand,
	resolveDesktopNotificationNavigation,
	resolveDesktopQuitPreflight,
} from "./desktop-app";
import { getDesktopProtectedDraftLabels } from "./desktop-draft-protection";
import { DesktopTransitionFreeze } from "./desktop-transition-freeze";

export interface UseDesktopAppInput {
	handlers: DesktopAppHandlers;
	projectActionsEnabled: boolean;
	runtimeConnected: boolean;
	selectedTask?: boolean;
	onboarding?: boolean;
	notificationNavigation?: DesktopNotificationNavigationContext & {
		selectProject: (projectId: string) => void;
		selectTask: (taskId: string) => void;
	};
	notificationProjects: RuntimeProjectNotificationStateMap;
	/** Open task draft editors require their ordinary save or cancel flow. */
	taskDraftCount: number;
	openProjectByPath?: (path: string, canNavigate: () => boolean) => Promise<void>;
}

const noFileSubscription = (): (() => void) => () => {};
const browserProjectLaunchReady = (): boolean => true;
function desktopFileProjectLaunchReady(): boolean {
	const recovery = getDesktopFileEditorRecoveryCommitStatus();
	return recovery.ready || recovery.problem !== null || getFileEditorDrafts(null).length > 0;
}

export function useDesktopApp(input: UseDesktopAppInput): boolean {
	const desktop = getRuntimeEnvironment().kind === "desktop";
	const fileProjectLaunchReady = useSyncExternalStore(
		desktop ? subscribeFileEditorCache : noFileSubscription,
		desktop ? desktopFileProjectLaunchReady : browserProjectLaunchReady,
		browserProjectLaunchReady,
	);
	const [frozen, setFrozen] = useState(false);
	const latest = useRef(input);
	// An intent awaiting the existing project/board hydration owners; never a second navigation state.
	const pendingNotification = useRef<DesktopNotificationTarget | null>(null);
	latest.current = input;
	useEffect(() => {
		const environment = getRuntimeEnvironment();
		if (environment.kind !== "desktop") return;
		const bridge = window.quarterdeckDesktop;
		let subscribed = true;
		const freeze = new DesktopTransitionFreeze(setFrozen);
		const offCommand = bridge?.onCommand?.((command) => {
			if (freeze.active) return;
			const current = latest.current;
			dispatchDesktopAppCommand(
				command,
				environment.runtimeGeneration,
				current.handlers,
				deriveAppCommandAvailability({
					...current,
					selectedTask: current.selectedTask ?? false,
					onboarding: current.onboarding ?? false,
				}),
			);
		});
		const offOpenProject = bridge?.onOpenProject?.((request) => {
			const parsed = desktopProjectOpenRequestSchema.safeParse(request);
			if (!parsed.success || parsed.data.runtimeGeneration !== environment.runtimeGeneration) return;
			const canNavigate = (): boolean => {
				const current = latest.current;
				if (!subscribed || freeze.active || !current.runtimeConnected || current.onboarding) return false;
				const files = getFileEditorDrafts(null);
				if (
					files.length > 0 ||
					current.taskDraftCount > 0 ||
					getDesktopProtectedDraftLabels().length > 0 ||
					!getDesktopFileEditorRecoveryCommitStatus().ready
				) {
					if (files.length > 0) setFileEditorReviewTarget("all");
					showAppToast({
						intent: "warning",
						message:
							"Save or cancel your unsaved work, then run quarterdeck --desktop again to open this project.",
						timeout: 7_000,
					});
					return false;
				}
				return true;
			};
			if (canNavigate()) void latest.current.openProjectByPath?.(parsed.data.projectPath, canNavigate);
		});
		const offNotification = bridge?.onNotificationTarget?.((target) => {
			pendingNotification.current = null;
			const current = latest.current;
			const context = current.notificationNavigation;
			if (freeze.active || current.onboarding || !context) return;
			const decision = resolveDesktopNotificationNavigation(
				target,
				environment.runtimeGeneration,
				context,
				current.runtimeConnected,
				current.taskDraftCount,
			);
			if (decision.kind === "blocked") {
				showAppToast({
					intent: "warning",
					message: "Save or cancel your task draft before opening this notification.",
					timeout: 6_000,
				});
			} else if (decision.kind === "project" || decision.kind === "wait") {
				pendingNotification.current = desktopNotificationTargetSchema.parse(target);
				if (decision.kind === "project") context.selectProject(decision.projectId);
			} else if (decision.kind === "task") context.selectTask(decision.taskId);
			else if (decision.kind === "home") current.handlers.navigate("home");
		});
		const offPreflight = bridge?.onQuitPreflight?.((request) => {
			const current = latest.current;
			const fileDrafts = getFileEditorDrafts(null);
			const protectedDraftLabels = getDesktopProtectedDraftLabels();
			const status = deriveDesktopFrontendStatus(
				current.notificationProjects,
				fileDrafts.length + current.taskDraftCount + protectedDraftLabels.length,
				current.runtimeConnected,
			);
			const recovery = getDesktopFileEditorRecoveryCommitStatus();
			const response = resolveDesktopQuitPreflight(request, environment.runtimeGeneration, status, recovery.ready);
			if (!response) return;
			const parsed = desktopQuitPreflightRequestSchema.safeParse(request);
			if (response.decision === "ready" && parsed.success && !freeze.seal(parsed.data))
				response.decision = "blocked";
			if (freeze.active) pendingNotification.current = null;
			if (!recovery.ready)
				showAppToast({
					intent: "warning",
					message: recovery.problem
						? "Recovery storage is not ready. Retry recovery, save or export your work, and resolve the storage problem before continuing."
						: "Wait for file recovery storage to finish loading or saving before continuing.",
					timeout: 6_000,
				});
			if (fileDrafts.length > 0) setFileEditorReviewTarget("all");
			if (current.taskDraftCount > 0)
				showAppToast({
					intent: "warning",
					message: "Save or cancel your task draft before continuing.",
					timeout: 6_000,
				});
			if (protectedDraftLabels.length > 0)
				showAppToast({
					intent: "warning",
					message: `Save or cancel ${protectedDraftLabels.join(" and ")} before continuing.`,
					timeout: 6_000,
				});
			bridge?.respondQuitPreflight?.(response);
		});
		const offRelease = bridge?.onPreflightReleased?.((release) => freeze.acceptRelease(release));
		return () => {
			subscribed = false;
			pendingNotification.current = null;
			bridge?.publishCommandAvailability?.({
				runtimeGeneration: environment.runtimeGeneration,
				runtimeConnected: false,
				commands: [],
			});
			offCommand?.();
			offOpenProject?.();
			offNotification?.();
			offPreflight?.();
			offRelease?.();
			freeze.release();
		};
	}, []);
	const notification = input.notificationNavigation;
	const projectKey = notification?.projectIds.join(",");
	const taskKey = notification?.taskIds.join(",");
	useEffect(() => {
		const target = pendingNotification.current;
		const context = latest.current.notificationNavigation;
		if (!target || !context) return;
		if (
			frozen ||
			!latest.current.runtimeConnected ||
			latest.current.onboarding ||
			(context.navigationProjectId !== target.projectId && context.currentProjectId !== target.projectId)
		) {
			pendingNotification.current = null;
			return;
		}
		const decision = resolveDesktopNotificationNavigation(
			target,
			target.runtimeGeneration,
			context,
			latest.current.runtimeConnected,
			latest.current.taskDraftCount,
		);
		if (decision.kind === "project" || decision.kind === "wait") return;
		// The existing task navigation owner clears selection in its project-switch effect.
		// Consume this intent after that commit, then recheck the latest hydrated board.
		queueMicrotask(() => {
			if (pendingNotification.current !== target) return;
			pendingNotification.current = null;
			const current = latest.current;
			const navigation = current.notificationNavigation;
			if (!navigation || current.onboarding) return;
			const next = resolveDesktopNotificationNavigation(
				target,
				target.runtimeGeneration,
				navigation,
				current.runtimeConnected,
				current.taskDraftCount,
			);
			if (next.kind === "task") navigation.selectTask(next.taskId);
			else if (next.kind === "home") current.handlers.navigate("home");
		});
	}, [
		notification?.currentProjectId,
		notification?.boardProjectId,
		notification?.navigationProjectId,
		notification?.isProjectSwitching,
		projectKey,
		taskKey,
		input.runtimeConnected,
		input.onboarding,
		input.taskDraftCount,
		frozen,
	]);
	useEffect(() => {
		if (getRuntimeEnvironment().kind !== "desktop") return;
		window.quarterdeckDesktop?.reportNotificationContext?.({
			currentProjectId: input.runtimeConnected ? (notification?.currentProjectId ?? null) : null,
		});
	}, [notification?.currentProjectId, input.runtimeConnected]);
	const commands = deriveAppCommandAvailability({
		...input,
		selectedTask: input.selectedTask ?? false,
		onboarding: input.onboarding ?? false,
		frozen,
	});
	const commandKey = commands.join(",");
	// Clean initial recovery loading may outlast runtime startup. Known dirty work
	// and storage errors must instead receive and refuse one intent immediately.
	const projectLaunchReady =
		fileProjectLaunchReady || input.taskDraftCount > 0 || getDesktopProtectedDraftLabels().length > 0;
	useEffect(() => {
		const environment = getRuntimeEnvironment();
		if (environment.kind !== "desktop") return;
		window.quarterdeckDesktop?.publishCommandAvailability?.({
			runtimeGeneration: environment.runtimeGeneration,
			runtimeConnected: input.runtimeConnected,
			commands: deriveAppCommandAvailability({
				...latest.current,
				selectedTask: latest.current.selectedTask ?? false,
				onboarding: latest.current.onboarding ?? false,
				frozen,
			}),
			...(window.quarterdeckDesktop?.onOpenProject && latest.current.openProjectByPath
				? { projectLaunchReady }
				: {}),
		});
	}, [commandKey, frozen, input.runtimeConnected, input.openProjectByPath, projectLaunchReady]);

	return frozen;
}
