import { deriveTaskIndicatorState } from "@runtime-contract";
import type { RuntimeProjectNotificationStateMap } from "@/runtime/runtime-notification-projects";
import type {
	DesktopAppCommand,
	DesktopFrontendStatus,
	DesktopQuitPreflightResponse,
} from "../../../../src/shared/desktop-bridge-contract";
import {
	desktopAppCommandSchema,
	desktopNotificationTargetSchema,
	desktopQuitPreflightRequestSchema,
} from "../../../../src/shared/desktop-bridge-contract";

export interface DesktopAppHandlers {
	settings: () => void;
	diagnostics: () => void;
	newTask: () => void;
	openProject: () => void;
	navigate: (view: "home" | "files" | "git" | "terminal") => void;
	fileFinder: () => void;
	textSearch: () => void;
	toggleShell: () => void;
}

export interface AppCommandContext {
	runtimeConnected: boolean;
	projectActionsEnabled: boolean;
	selectedTask: boolean;
	onboarding: boolean;
	frozen?: boolean;
}

/** Shared availability for native menus and renderer shortcuts. Local app panels remain reachable offline. */
export function deriveAppCommandAvailability(context: AppCommandContext): DesktopAppCommand["command"][] {
	if (context.frozen) return [];
	const commands: DesktopAppCommand["command"][] = ["settings", "diagnostics"];
	if (!context.runtimeConnected || context.onboarding) return commands;
	commands.push("open-project");
	if (!context.projectActionsEnabled) return commands;
	commands.push("home", "files", "git", "new-task", "file-finder", "text-search", "toggle-shell");
	if (context.selectedTask) commands.push("terminal");
	return commands;
}

/** Native menu intents use the same action owners as ordinary UI gestures. */
export function dispatchDesktopAppCommand(
	event: unknown,
	generation: string,
	handlers: DesktopAppHandlers,
	commands: readonly DesktopAppCommand["command"][],
): boolean {
	const parsed = desktopAppCommandSchema.safeParse(event);
	if (!parsed.success || parsed.data.runtimeGeneration !== generation) return false;
	const command = parsed.data.command;
	if (!commands.includes(command)) return false;
	if (command === "settings") handlers.settings();
	else if (command === "diagnostics") handlers.diagnostics();
	else if (command === "open-project") handlers.openProject();
	else if (command === "new-task") handlers.newTask();
	else if (command === "file-finder") handlers.fileFinder();
	else if (command === "text-search") handlers.textSearch();
	else if (command === "toggle-shell") handlers.toggleShell();
	else handlers.navigate(command);
	return true;
}

export interface DesktopNotificationNavigationContext {
	currentProjectId: string | null;
	boardProjectId: string | null;
	navigationProjectId: string | null;
	projectIds: readonly string[];
	taskIds: readonly string[];
	isProjectSwitching: boolean;
}

export function resolveDesktopNotificationNavigation(
	event: unknown,
	generation: string,
	context: DesktopNotificationNavigationContext,
	runtimeConnected: boolean,
	dirtyTaskCount: number,
):
	| { kind: "ignore" | "blocked" | "home" | "wait" }
	| { kind: "project"; projectId: string }
	| { kind: "task"; taskId: string } {
	const parsed = desktopNotificationTargetSchema.safeParse(event);
	if (!parsed.success || parsed.data.runtimeGeneration !== generation || !runtimeConnected) return { kind: "ignore" };
	if (dirtyTaskCount > 0) return { kind: "blocked" };
	const target = parsed.data;
	if (!target.projectId || !context.projectIds.includes(target.projectId)) return { kind: "home" };
	if (target.projectId !== context.currentProjectId) return { kind: "project", projectId: target.projectId };
	if (context.isProjectSwitching || context.boardProjectId !== target.projectId) return { kind: "wait" };
	return target.taskId && context.taskIds.includes(target.taskId)
		? { kind: "task", taskId: target.taskId }
		: { kind: "home" };
}

export function deriveDesktopFrontendStatus(
	notificationProjects: RuntimeProjectNotificationStateMap,
	dirtyEditorCount: number,
	runtimeConnected: boolean,
): DesktopFrontendStatus {
	let activeSessionCount = 0;
	let needsInputSessionCount = 0;
	for (const project of Object.values(notificationProjects)) {
		for (const summary of Object.values(project.sessions)) {
			if (summary.pid !== null) activeSessionCount++;
			if (deriveTaskIndicatorState(summary).needsInput) needsInputSessionCount++;
		}
	}
	return { dirtyEditorCount, activeSessionCount, needsInputSessionCount, runtimeConnected };
}

/** Stale requests cannot clear a native preflight, and dirty or disconnected UI always vetoes. */
export function resolveDesktopQuitPreflight(
	request: unknown,
	generation: string,
	status: DesktopFrontendStatus,
	recoveryReady = true,
): DesktopQuitPreflightResponse | null {
	const parsed = desktopQuitPreflightRequestSchema.safeParse(request);
	if (!parsed.success || parsed.data.runtimeGeneration !== generation) return null;
	return {
		requestId: parsed.data.requestId,
		runtimeGeneration: generation,
		decision:
			recoveryReady && status.dirtyEditorCount === 0 && (parsed.data.reason !== "update" || status.runtimeConnected)
				? "ready"
				: "blocked",
		status,
	};
}
