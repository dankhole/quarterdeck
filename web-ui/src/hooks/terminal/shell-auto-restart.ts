import { DETAIL_TERMINAL_TASK_PREFIX, HOME_TERMINAL_TASK_ID } from "@/terminal/terminal-constants";

export const MAX_RESTARTS = 3;
export const RATE_LIMIT_WINDOW_MS = 30_000;
export const RESTART_DELAY_MS = 1000;

export type RestartTarget = { type: "home" } | { type: "detail"; cardId: string };

/**
 * Determine whether a task ID represents a restartable shell terminal.
 * Returns the parsed target or null if not restartable.
 */
export function parseRestartTarget(taskId: string): RestartTarget | null {
	if (taskId === HOME_TERMINAL_TASK_ID) {
		return { type: "home" };
	}
	if (taskId.startsWith(DETAIL_TERMINAL_TASK_PREFIX)) {
		const cardId = taskId.slice(DETAIL_TERMINAL_TASK_PREFIX.length);
		if (cardId) {
			return { type: "detail", cardId };
		}
	}
	return null;
}

/**
 * Check whether a restart is allowed given the recent restart timestamps.
 * Uses a sliding window rate limiter.
 */
export function canRestart(timestamps: number[], now: number): boolean {
	const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
	return recent.length < MAX_RESTARTS;
}

/**
 * Record a restart timestamp and return the pruned list (only recent entries).
 */
export function recordRestart(timestamps: number[], now: number): number[] {
	const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
	recent.push(now);
	return recent;
}
