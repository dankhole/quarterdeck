import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { registerTerminalController } from "@/terminal/terminal-controller-registry";
import {
	acquireForTask,
	disposeDedicatedTerminal,
	ensureDedicatedTerminal,
	isDedicatedTerminalTaskId,
	releaseTask,
} from "@/terminal/terminal-pool";
import type { TerminalSlot } from "@/terminal/terminal-slot";

interface UsePersistentTerminalSessionInput {
	taskId: string;
	workspaceId: string | null;
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
	isStopping: boolean;
	clearTerminal: () => void;
	stopTerminal: () => Promise<void>;
}

export function usePersistentTerminalSession({
	taskId,
	workspaceId,
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
		workspaceId: string;
		taskId: string;
		sessionStartedAt: number | null;
	} | null>(null);
	const [lastError, setLastError] = useState<string | null>(null);
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
					disposeDedicatedTerminal(previousSession.workspaceId, previousSession.taskId);
				}
				terminalRef.current?.unmount(containerRef.current);
				terminalRef.current = null;
				previousSessionRef.current = null;
				setLastError(null);
				setIsStopping(false);
				return;
			}

			if (!workspaceId) {
				const previousSession = previousSessionRef.current;
				if (previousSession) {
					disposeDedicatedTerminal(previousSession.workspaceId, previousSession.taskId);
				}
				terminalRef.current?.unmount(containerRef.current);
				terminalRef.current = null;
				previousSessionRef.current = null;
				setLastError("No project selected.");
				return;
			}
			const container = containerRef.current;
			if (!container) {
				return;
			}
			const previousSession = previousSessionRef.current;
			const didSessionRestart =
				previousSession !== null &&
				previousSession.workspaceId === workspaceId &&
				previousSession.taskId === taskId &&
				previousSession.sessionStartedAt !== sessionStartedAt;

			const terminal = ensureDedicatedTerminal({
				taskId,
				workspaceId,
				cursorColor,
				terminalBackgroundColor,
			});
			if (didSessionRestart) {
				terminal.reset();
			}
			previousSessionRef.current = {
				workspaceId,
				taskId,
				sessionStartedAt,
			};
			terminalRef.current = terminal;
			const unsubscribe = terminal.subscribe({
				onConnectionReady: (connectedTaskId) => {
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
			terminal.mount(
				container,
				{
					cursorColor,
					terminalBackgroundColor,
				},
				{
					autoFocus,
					isVisible,
				},
			);
			setLastError(null);
			setIsStopping(false);
			return () => {
				unsubscribe();
				terminal.unmount(container);
				if (terminalRef.current === terminal) {
					terminalRef.current = null;
				}
			};
		}

		// --- Pool path (regular agent task terminals) ---
		if (!enabled) {
			releaseTask(taskId);
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			setLastError(null);
			setIsStopping(false);
			return;
		}

		if (!workspaceId) {
			releaseTask(taskId);
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			setLastError("No project selected.");
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}

		const terminal = acquireForTask(taskId, workspaceId);
		terminalRef.current = terminal;
		const unsubscribe = terminal.subscribe({
			onConnectionReady: (connectedTaskId) => {
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
		terminal.mount(
			container,
			{
				cursorColor,
				terminalBackgroundColor,
			},
			{
				autoFocus,
				isVisible,
			},
		);
		setLastError(null);
		setIsStopping(false);
		return () => {
			unsubscribe();
			terminal.unmount(container);
			if (terminalRef.current === terminal) {
				terminalRef.current = null;
			}
		};
	}, [autoFocus, cursorColor, enabled, isVisible, sessionStartedAt, taskId, terminalBackgroundColor, workspaceId]);

	useEffect(() => {
		return registerTerminalController(taskId, {
			input: (text) => terminalRef.current?.input(text) ?? false,
			paste: (text) => terminalRef.current?.paste(text) ?? false,
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
		isStopping,
		clearTerminal,
		stopTerminal,
	};
}
