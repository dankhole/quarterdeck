import { useCallback, useEffect, useRef } from "react";

import {
	canRestart as canRestartCheck,
	parseRestartTarget,
	RESTART_DELAY_MS,
	recordRestart as recordRestartTimestamp,
} from "@/hooks/terminal/shell-auto-restart";

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
	suppressNextExit: (taskId: string) => void;
	clearSuppressedExit: (taskId: string) => void;
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
	const suppressedNextExitRef = useRef<Set<string>>(new Set());

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
		const timestamps = rateLimiterRef.current.get(taskId) ?? [];
		return canRestartCheck(timestamps, Date.now());
	}, []);

	const recordRestart = useCallback((taskId: string): void => {
		const timestamps = rateLimiterRef.current.get(taskId) ?? [];
		rateLimiterRef.current.set(taskId, recordRestartTimestamp(timestamps, Date.now()));
	}, []);

	const cancelPendingRestart = useCallback((taskId: string): void => {
		const timer = pendingTimersRef.current.get(taskId);
		if (timer != null) {
			clearTimeout(timer);
			pendingTimersRef.current.delete(taskId);
		}
	}, []);

	const suppressNextExit = useCallback(
		(taskId: string): void => {
			suppressedNextExitRef.current.add(taskId);
			cancelPendingRestart(taskId);
		},
		[cancelPendingRestart],
	);

	const clearSuppressedExit = useCallback((taskId: string): void => {
		suppressedNextExitRef.current.delete(taskId);
	}, []);

	const handleShellExit = useCallback(
		(taskId: string, exitCode: number | null) => {
			if (suppressedNextExitRef.current.delete(taskId)) {
				return;
			}
			if (exitCode === 0) {
				return;
			}
			if (restartInProgressRef.current.has(taskId)) {
				return;
			}
			if (!optionsRef.current.shellAutoRestartEnabled) {
				return;
			}

			const target = parseRestartTarget(taskId);
			if (!target) {
				return;
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
					if (target.type === "home") {
						optionsRef.current.restartHomeTerminal();
					} else {
						optionsRef.current.restartDetailTerminal(target.cardId);
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
			suppressedNextExitRef.current.clear();
		};
	}, []);

	return { handleShellExit, cancelPendingRestart, suppressNextExit, clearSuppressedExit };
}
