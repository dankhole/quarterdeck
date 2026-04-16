export const HOME_TERMINAL_TASK_ID = "__home_terminal__";
export const DETAIL_TERMINAL_TASK_PREFIX = "__detail_terminal__:";

export function getDetailTerminalTaskId(taskId: string): string {
	return `${DETAIL_TERMINAL_TASK_PREFIX}${taskId}`;
}
