import { useCallback, useEffect, useRef } from "react";

import {
	canRestart as canRestartCheck,
	parseRestartTarget,
	RESTART_DELAY_MS,
	recordRestart as recordRestartTimestamp,
} from "@/hooks/terminal/shell-auto-restart";
import { getUnexpectedShellExitInstance } from "@/hooks/terminal/terminal-panels";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TerminalControllerAttachment } from "@/terminal/terminal-controller-registry";

interface UseShellAutoRestartOptions {
	projectId: string | null;
	/** Changes for navigation, hide/reopen, explicit restart, and termination. */
	scopeKey: string;
	shellAutoRestartEnabled: boolean;
	restartHomeTerminal: (
		expectedSessionInstanceId: string,
		attachment: TerminalControllerAttachment,
	) => Promise<boolean>;
	restartDetailTerminal: (
		cardId: string,
		expectedSessionInstanceId: string,
		attachment: TerminalControllerAttachment,
	) => Promise<boolean>;
	writeToTerminal: (taskId: string, message: string) => void;
	getTerminalAttachment: (taskId: string, sessionInstanceId: string) => TerminalControllerAttachment | null;
	getSessionSummary: (taskId: string) => RuntimeTaskSessionSummary | null;
}

export interface UseShellAutoRestartResult {
	handleShellExit: (taskId: string, exitCode: number | null) => void;
	cancelPendingRestart: (taskId: string) => void;
}

/** Optional visible-viewer policy. The runtime atomically validates the expected exited instance before start. */
export function useShellAutoRestart(options: UseShellAutoRestartOptions): UseShellAutoRestartResult {
	const { projectId, scopeKey } = options;
	const rateLimiterRef = useRef<Map<string, number[]>>(new Map());
	const pendingTimersRef = useRef<Map<string, () => void>>(new Map());
	const restartInProgressRef = useRef<Map<string, object>>(new Map());
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const cancelPendingRestart = useCallback((taskId: string): void => {
		pendingTimersRef.current.get(taskId)?.();
	}, []);

	const handleShellExit = useCallback(
		(taskId: string, exitCode: number | null) => {
			const current = optionsRef.current;
			if (current.scopeKey !== scopeKey || !projectId || current.projectId !== projectId) return;
			// Unknown/signal exits cannot establish an unexpected failure and must not resurrect an explicit stop.
			if (exitCode === null || exitCode === 0 || !current.shellAutoRestartEnabled) return;
			const target = parseRestartTarget(taskId);
			const sessionInstanceId = current.getSessionSummary(taskId)?.sessionInstanceId;
			if (!target || !sessionInstanceId) return;
			const attachment = current.getTerminalAttachment(taskId, sessionInstanceId);
			if (!attachment || attachment.signal.aborted) return;
			if (pendingTimersRef.current.has(taskId) || restartInProgressRef.current.has(taskId)) return;

			const isSameAttachment = () => {
				const latest = optionsRef.current;
				return (
					latest.scopeKey === scopeKey &&
					latest.projectId === projectId &&
					latest.shellAutoRestartEnabled &&
					!attachment.signal.aborted &&
					latest.getTerminalAttachment(taskId, sessionInstanceId) === attachment
				);
			};
			const cancel = () => {
				clearTimeout(timer);
				attachment.signal.removeEventListener("abort", cancel);
				if (pendingTimersRef.current.get(taskId) === cancel) pendingTimersRef.current.delete(taskId);
			};
			const timer = setTimeout(() => {
				cancel();
				if (!isSameAttachment()) return;
				const latest = optionsRef.current;
				const summary = latest.getSessionSummary(taskId);
				if (getUnexpectedShellExitInstance(summary) !== sessionInstanceId || summary?.exitCode !== exitCode) return;

				const rateKey = JSON.stringify([projectId, taskId]);
				const timestamps = rateLimiterRef.current.get(rateKey) ?? [];
				if (!canRestartCheck(timestamps, Date.now())) {
					latest.writeToTerminal(
						taskId,
						"\r\n[quarterdeck] shell could not be restarted automatically, click restart to try again\r\n",
					);
					return;
				}
				rateLimiterRef.current.set(rateKey, recordRestartTimestamp(timestamps, Date.now()));
				latest.writeToTerminal(taskId, "\r\n[quarterdeck] shell exited unexpectedly, restarting...\r\n");
				const operation = {};
				restartInProgressRef.current.set(taskId, operation);
				void Promise.resolve()
					.then(() => {
						if (!isSameAttachment()) return false;
						return target.type === "home"
							? latest.restartHomeTerminal(sessionInstanceId, attachment)
							: latest.restartDetailTerminal(target.cardId, sessionInstanceId, attachment);
					})
					.catch(() => {})
					.finally(() => {
						if (restartInProgressRef.current.get(taskId) === operation)
							restartInProgressRef.current.delete(taskId);
					});
			}, RESTART_DELAY_MS);
			pendingTimersRef.current.set(taskId, cancel);
			attachment.signal.addEventListener("abort", cancel, { once: true });
		},
		[projectId, scopeKey],
	);

	useEffect(() => {
		return () => {
			for (const cancel of pendingTimersRef.current.values()) cancel();
			restartInProgressRef.current.clear();
		};
	}, [scopeKey]);
	useEffect(() => {
		rateLimiterRef.current.clear();
	}, [projectId]);

	return { handleShellExit, cancelPendingRestart };
}
