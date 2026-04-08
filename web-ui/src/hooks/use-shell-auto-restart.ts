import { useCallback, useEffect, useRef } from "react";

import { DETAIL_TERMINAL_TASK_PREFIX, HOME_TERMINAL_TASK_ID } from "@/hooks/terminal-constants";

const MAX_RESTARTS = 3;
const RATE_LIMIT_WINDOW_MS = 30_000;
const RESTART_DELAY_MS = 1000;

interface UseShellAutoRestartOptions {
	shellAutoRestartEnabled: boolean;
	restartHomeTerminal: () => void;
	restartDetailTerminal: (cardId: string) => void;
	writeToTerminal: (taskId: string, message: string) => void;
	isSessionRunning: (taskId: string) => boolean;
}

export interface UseShellAutoRestartResult {
	handleShellExit: (taskId: string, exitCode: number | null) => void;
	cancelPendingRestart: (taskId: string) => void;
}

export function useShellAutoRestart({
	shellAutoRestartEnabled,
	restartHomeTerminal,
	restartDetailTerminal,
	writeToTerminal,
	isSessionRunning,
}: UseShellAutoRestartOptions): UseShellAutoRestartResult {
	const rateLimiterRef = useRef<Map<string, number[]>>(new Map());
	const pendingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
	const restartInProgressRef = useRef<Set<string>>(new Set());

	const optionsRef = useRef({
		shellAutoRestartEnabled,
		restartHomeTerminal,
		restartDetailTerminal,
		writeToTerminal,
		isSessionRunning,
	});
	optionsRef.current = {
		shellAutoRestartEnabled,
		restartHomeTerminal,
		restartDetailTerminal,
		writeToTerminal,
		isSessionRunning,
	};

	const canRestart = useCallback((taskId: string): boolean => {
		const now = Date.now();
		const timestamps = rateLimiterRef.current.get(taskId) ?? [];
		const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
		return recent.length < MAX_RESTARTS;
	}, []);

	const recordRestart = useCallback((taskId: string): void => {
		const now = Date.now();
		const timestamps = rateLimiterRef.current.get(taskId) ?? [];
		const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
		recent.push(now);
		rateLimiterRef.current.set(taskId, recent);
	}, []);

	const cancelPendingRestart = useCallback((taskId: string): void => {
		const timer = pendingTimersRef.current.get(taskId);
		if (timer != null) {
			clearTimeout(timer);
			pendingTimersRef.current.delete(taskId);
		}
	}, []);

	const handleShellExit = useCallback(
		(taskId: string, exitCode: number | null) => {
			if (exitCode === 0) {
				return;
			}
			if (restartInProgressRef.current.has(taskId)) {
				return;
			}
			if (!optionsRef.current.shellAutoRestartEnabled) {
				return;
			}

			// Validate taskId is a known restartable pattern.
			const isHome = taskId === HOME_TERMINAL_TASK_ID;
			const isDetail = taskId.startsWith(DETAIL_TERMINAL_TASK_PREFIX);
			if (!isHome && !isDetail) {
				return;
			}
			if (isDetail) {
				const cardId = taskId.slice(DETAIL_TERMINAL_TASK_PREFIX.length);
				if (!cardId) {
					return;
				}
			}

			if (!canRestart(taskId)) {
				optionsRef.current.writeToTerminal(
					taskId,
					"\r\n[quarterdeck] shell could not be restarted automatically, click restart to try again\r\n",
				);
				return;
			}

			// If there's already a pending restart for this taskId, skip (avoid duplicate messages)
			if (pendingTimersRef.current.has(taskId)) {
				return;
			}

			optionsRef.current.writeToTerminal(taskId, "\r\n[quarterdeck] shell exited unexpectedly, restarting...\r\n");

			const timer = setTimeout(() => {
				pendingTimersRef.current.delete(taskId);

				if (optionsRef.current.isSessionRunning(taskId)) {
					return;
				}

				recordRestart(taskId);
				restartInProgressRef.current.add(taskId);

				try {
					if (taskId === HOME_TERMINAL_TASK_ID) {
						optionsRef.current.restartHomeTerminal();
					} else {
						const cardId = taskId.slice(DETAIL_TERMINAL_TASK_PREFIX.length);
						optionsRef.current.restartDetailTerminal(cardId);
					}
				} catch {
					// Sync error from restart handler, unlikely but safe to swallow.
				} finally {
					restartInProgressRef.current.delete(taskId);
				}
			}, RESTART_DELAY_MS);

			pendingTimersRef.current.set(taskId, timer);
		},
		[canRestart, recordRestart],
	);

	// Clean up all pending timers on unmount.
	useEffect(() => {
		return () => {
			for (const timer of pendingTimersRef.current.values()) {
				clearTimeout(timer);
			}
			pendingTimersRef.current.clear();
		};
	}, []);

	return { handleShellExit, cancelPendingRestart };
}
