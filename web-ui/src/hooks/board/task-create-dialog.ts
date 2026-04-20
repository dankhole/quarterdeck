import { DEFAULT_PRIMARY_START_ACTION, type TaskCreateStartAction } from "@/components/task/task-create-dialog-utils";

export type TaskCreateMode = "single" | "multi";

export type TaskCreateHotkeyAction =
	| "create_single"
	| "start_single"
	| "start_and_open_single"
	| "create_all"
	| "start_all";

interface TaskCreateDialogCopy {
	dialogTitle: string;
	taskCountLabel: string;
	primaryStartLabel: string;
	primaryStartIncludesShift: boolean;
	secondaryStartAction: TaskCreateStartAction;
	secondaryStartLabel: string;
	secondaryStartIncludesShift: boolean;
}

export function getValidTaskPrompts(taskPrompts: string[]): string[] {
	return taskPrompts.filter((taskPrompt) => taskPrompt.trim().length > 0);
}

export function joinTaskPromptsForSingleMode(taskPrompts: string[]): string {
	return getValidTaskPrompts(taskPrompts)
		.map((taskPrompt, index) => `${index + 1}. ${taskPrompt}`)
		.join("\n");
}

export function resolveEffectivePrimaryStartAction(
	primaryStartAction: TaskCreateStartAction,
	hasStartAndOpenAction: boolean,
): TaskCreateStartAction {
	if (!hasStartAndOpenAction && primaryStartAction === "start_and_open") {
		return DEFAULT_PRIMARY_START_ACTION;
	}
	return primaryStartAction;
}

export function resolveTaskCreateHotkeyAction(
	mode: TaskCreateMode,
	modifiers: { altKey: boolean; shiftKey: boolean },
): TaskCreateHotkeyAction {
	if (mode === "multi") {
		return modifiers.altKey ? "create_all" : "start_all";
	}
	if (modifiers.altKey) {
		return "create_single";
	}
	if (modifiers.shiftKey) {
		return "start_and_open_single";
	}
	return "start_single";
}

export function resolveTaskCreateDialogCopy(
	mode: TaskCreateMode,
	validTaskCount: number,
	primaryStartAction: TaskCreateStartAction,
): TaskCreateDialogCopy {
	const secondaryStartAction = primaryStartAction === "start" ? "start_and_open" : "start";
	return {
		dialogTitle: mode === "multi" ? `New tasks${validTaskCount > 0 ? ` (${validTaskCount})` : ""}` : "New task",
		taskCountLabel: validTaskCount === 1 ? "task" : "tasks",
		primaryStartLabel: primaryStartAction === "start" ? "Start task" : "Start and open",
		primaryStartIncludesShift: primaryStartAction === "start_and_open",
		secondaryStartAction,
		secondaryStartLabel: secondaryStartAction === "start" ? "Start task" : "Start and open",
		secondaryStartIncludesShift: secondaryStartAction === "start_and_open",
	};
}
