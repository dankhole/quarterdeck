import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { registerTerminalController } from "@/terminal/terminal-controller-registry";
import {
	acquireForTask,
	attachPoolContainer,
	disposeDedicatedTerminal,
	ensureDedicatedTerminal,
	isDedicatedTerminalTaskId,
	releaseTask,
} from "@/terminal/terminal-pool";
import type { TerminalSlot } from "@/terminal/terminal-slot";

interface UsePersistentTerminalSessionInput {
	taskId: string;
	projectId: string | null;
	enabled?: boolean;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
	onExit?: (taskId: string, exitCode: number | null) => void;
	autoFocus?: boolean;
	isVisible?: boolean;
	sessionStartedAt?: number | null;
	terminalBackgroundColor: string;
	cursorColor: string;
}

export interface UsePersistentTerminalSessionResult {
	containerRef: MutableRefObject<HTMLDivElement | null>;
	lastError: string | null;
	isLoading: boolean;
	isStopping: boolean;
	clearTerminal: () => void;
	stopTerminal: () => Promise<void>;
}

export function usePersistentTerminalSession({
	taskId,
	projectId,
	enabled = true,
	onSummary,
	onConnectionReady,
	onExit,
	autoFocus = false,
	isVisible = true,
	sessionStartedAt = null,
	terminalBackgroundColor,
	cursorColor,
}: UsePersistentTerminalSessionInput): UsePersistentTerminalSessionResult {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<TerminalSlot | null>(null);
	const callbackRef = useRef<{
		onSummary?: (summary: RuntimeTaskSessionSummary) => void;
		onConnectionReady?: (taskId: string) => void;
		onExit?: (taskId: string, exitCode: number | null) => void;
	}>({
		onSummary,
		onConnectionReady,
		onExit,
	});
	const previousSessionRef = useRef<{
		projectId: string;
		taskId: string;
		sessionStartedAt: number | null;
	} | null>(null);
	const [lastError, setLastError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isStopping, setIsStopping] = useState(false);
	callbackRef.current = {
		onSummary,
		onConnectionReady,
		onExit,
	};

	useEffect(() => {
		const isDedicated = isDedicatedTerminalTaskId(taskId);

		// --- Dedicated path (home shell, dev shells) ---
		if (isDedicated) {
			if (!enabled) {
				const previousSession = previousSessionRef.current;
				if (previousSession) {
					disposeDedicatedTerminal(previousSession.projectId, previousSession.taskId);
				}
				terminalRef.current?.hide();
				terminalRef.current = null;
				previousSessionRef.current = null;
				setLastError(null);
				setIsLoading(false);
				setIsStopping(false);
				return;
			}

			if (!projectId) {
				const previousSession = previousSessionRef.current;
				if (previousSession) {
					disposeDedicatedTerminal(previousSession.projectId, previousSession.taskId);
				}
				terminalRef.current?.hide();
				terminalRef.current = null;
				previousSessionRef.current = null;
				setLastError("No project selected.");
				setIsLoading(false);
				return;
			}
			const container = containerRef.current;
			if (!container) {
				return;
			}
			const previousSession = previousSessionRef.current;
			const didSessionRestart =
				previousSession !== null &&
				previousSession.projectId === projectId &&
				previousSession.taskId === taskId &&
				previousSession.sessionStartedAt !== sessionStartedAt;

			const terminal = ensureDedicatedTerminal({
				taskId,
				projectId,
				cursorColor,
				terminalBackgroundColor,
			});
			if (didSessionRestart) {
				terminal.reset();
			}
			previousSessionRef.current = {
				projectId,
				taskId,
				sessionStartedAt,
			};
			terminalRef.current = terminal;
			setLastError(null);
			setIsLoading(true);
			setIsStopping(false);
			const unsubscribe = terminal.subscribe({
				onConnectionReady: (connectedTaskId) => {
					setIsLoading(false);
					callbackRef.current.onConnectionReady?.(connectedTaskId);
				},
				onLastError: setLastError,
				onSummary: (summary) => {
					callbackRef.current.onSummary?.(summary);
				},
				onExit: (exitTaskId, exitCode) => {
					callbackRef.current.onExit?.(exitTaskId, exitCode);
				},
			});
			terminal.attachToStageContainer(container);
			terminal.show({ cursorColor, terminalBackgroundColor }, { autoFocus, isVisible });
			return () => {
				unsubscribe();
				terminal.hide();
				// Park the host element back to the off-screen root before React
				// removes the container div from the DOM. Without this, the xterm
				// canvas becomes detached from the live DOM on unmount, causing
				// WebGL context loss and a blank terminal on next open.
				terminal.park();
				if (terminalRef.current === terminal) {
					terminalRef.current = null;
				}
			};
		}

		// --- Pool path (regular agent task terminals) ---
		if (!enabled) {
			releaseTask(taskId);
			terminalRef.current?.hide();
			terminalRef.current = null;
			setLastError(null);
			setIsLoading(false);
			setIsStopping(false);
			return;
		}

		if (!projectId) {
			releaseTask(taskId);
			terminalRef.current?.hide();
			terminalRef.current = null;
			setLastError("No project selected.");
			setIsLoading(false);
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}

		// Ensure pool slots are staged in this container (idempotent for same container).
		attachPoolContainer(container);

		const previousSession = previousSessionRef.current;
		const didSessionRestart =
			previousSession !== null &&
			previousSession.projectId === projectId &&
			previousSession.taskId === taskId &&
			previousSession.sessionStartedAt !== sessionStartedAt;

		const terminal = acquireForTask(taskId, projectId);
		if (didSessionRestart) {
			terminal.reset();
		}
		previousSessionRef.current = { projectId, taskId, sessionStartedAt };
		terminalRef.current = terminal;
		setLastError(null);
		setIsLoading(true);
		setIsStopping(false);
		const unsubscribe = terminal.subscribe({
			onConnectionReady: (connectedTaskId) => {
				setIsLoading(false);
				callbackRef.current.onConnectionReady?.(connectedTaskId);
			},
			onLastError: setLastError,
			onSummary: (summary) => {
				callbackRef.current.onSummary?.(summary);
			},
			onExit: (exitTaskId, exitCode) => {
				callbackRef.current.onExit?.(exitTaskId, exitCode);
			},
		});
		terminal.show({ cursorColor, terminalBackgroundColor }, { autoFocus, isVisible });
		return () => {
			unsubscribe();
			terminal.hide();
			if (terminalRef.current === terminal) {
				terminalRef.current = null;
			}
		};
	}, [autoFocus, cursorColor, enabled, isVisible, sessionStartedAt, taskId, terminalBackgroundColor, projectId]);

	useEffect(() => {
		return registerTerminalController(taskId, {
			input: (text) => terminalRef.current?.input(text) ?? false,
			paste: (text) => terminalRef.current?.paste(text) ?? false,
			focus: () => terminalRef.current?.focus(),
			waitForLikelyPrompt: async (timeoutMs) => await (terminalRef.current?.waitForLikelyPrompt(timeoutMs) ?? false),
		});
	}, [taskId]);

	const stopTerminal = useCallback(async () => {
		const terminal = terminalRef.current;
		if (!terminal) {
			return;
		}
		setIsStopping(true);
		try {
			await terminal.stop();
		} catch {
			// Keep terminal usable even if stop API fails.
		} finally {
			setIsStopping(false);
		}
	}, []);

	const clearTerminal = useCallback(() => {
		terminalRef.current?.clear();
	}, []);

	return {
		containerRef,
		lastError,
		isLoading,
		isStopping,
		clearTerminal,
		stopTerminal,
	};
}
