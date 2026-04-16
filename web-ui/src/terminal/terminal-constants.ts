export const HOME_TERMINAL_TASK_ID = "__home_terminal__";
export const DETAIL_TERMINAL_TASK_PREFIX = "__detail_terminal__:";
/** Scrollback buffer size shared by pool slots and dedicated terminals. Keep in sync with session-manager.ts server-side headless mirror. */
export const TERMINAL_SCROLLBACK = 1_500;

export function getDetailTerminalTaskId(taskId: string): string {
	return `${DETAIL_TERMINAL_TASK_PREFIX}${taskId}`;
}
