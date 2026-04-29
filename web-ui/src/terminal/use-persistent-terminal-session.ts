import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { registerTerminalController } from "@/terminal/terminal-controller-registry";
import { disposeDedicatedTerminal, ensureDedicatedTerminal, isDedicatedTerminalTaskId } from "@/terminal/terminal-pool";
import {
	acquireTaskTerminal,
	releaseTaskTerminal,
	stageTaskTerminalContainer,
	type TaskTerminalHandle,
} from "@/terminal/terminal-reuse-manager";
import { createClientLogger } from "@/utils/client-logger";

const log = createClientLogger("persistent-terminal-session");

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
	requestRestore: () => boolean;
	stopTerminal: () => Promise<void>;
}

function clearMountedTerminal(
	terminalRef: MutableRefObject<TaskTerminalHandle | null>,
	previousSessionRef: MutableRefObject<{
		projectId: string;
		taskId: string;
		sessionStartedAt: number | null;
	} | null>,
): void {
	terminalRef.current?.hide();
	terminalRef.current = null;
	previousSessionRef.current = null;
}

function disposeDedicatedShellTerminal(
	terminalRef: MutableRefObject<TaskTerminalHandle | null>,
	previousSessionRef: MutableRefObject<{
		projectId: string;
		taskId: string;
		sessionStartedAt: number | null;
	} | null>,
): void {
	const previousSession = previousSessionRef.current;
	if (previousSession) {
		disposeDedicatedTerminal(previousSession.projectId, previousSession.taskId);
	}
	clearMountedTerminal(terminalRef, previousSessionRef);
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
	const terminalRef = useRef<TaskTerminalHandle | null>(null);
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
		const isDedicatedShellTerminal = isDedicatedTerminalTaskId(taskId);

		// Dedicated shell terminals own their session lifecycle directly.
		// These are workspace-scoped manual shells, not pooled task agent viewers.
		if (isDedicatedShellTerminal) {
			if (!enabled) {
				log.debug("dedicated shell terminal disabled; disposing", { taskId, projectId });
				disposeDedicatedShellTerminal(terminalRef, previousSessionRef);
				setLastError(null);
				setIsLoading(false);
				setIsStopping(false);
				return;
			}

			if (!projectId) {
				log.warn("dedicated shell terminal cannot show without a project", { taskId });
				disposeDedicatedShellTerminal(terminalRef, previousSessionRef);
				setLastError("No project selected.");
				setIsLoading(false);
				return;
			}
			const container = containerRef.current;
			if (!container) {
				log.debug("dedicated shell terminal waiting for container", { taskId, projectId });
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
			log.debug("showing dedicated shell terminal", {
				taskId,
				projectId,
				sessionStartedAt,
				didSessionRestart,
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
				onConnectionReady: (connectedTaskId: string) => {
					log.debug("dedicated shell terminal connection ready", { taskId: connectedTaskId, projectId });
					setIsLoading(false);
					callbackRef.current.onConnectionReady?.(connectedTaskId);
				},
				onLastError: (message: string | null) => {
					if (message) {
						log.warn("dedicated shell terminal connection error", { taskId, projectId, message });
					}
					setLastError(message);
				},
				onSummary: (summary: RuntimeTaskSessionSummary) => {
					callbackRef.current.onSummary?.(summary);
				},
				onExit: (exitTaskId: string, exitCode: number | null) => {
					log.info("dedicated shell terminal exited", { taskId: exitTaskId, projectId, exitCode });
					callbackRef.current.onExit?.(exitTaskId, exitCode);
				},
			});
			terminal.attachToStageContainer(container);
			terminal.show({ cursorColor, terminalBackgroundColor }, { autoFocus, isVisible });
			return () => {
				log.debug("hiding dedicated shell terminal view", { taskId, projectId });
				unsubscribe();
				terminal.hide();
				// This cleanup runs for ordinary React unmounts/remounts while a
				// shell is still logically open. It is not the shell-close path:
				// use-terminal-panels disposes the dedicated terminal slot when a
				// shell is closed or its owning context changes. Park here only to
				// keep an open shell's xterm host in the live DOM while React removes
				// this container, preventing WebGL context loss on remount.
				terminal.park();
				if (terminalRef.current === terminal) {
					terminalRef.current = null;
				}
			};
		}

		// Shared task terminals are the pooled agent-terminal path.
		if (!enabled) {
			releaseTaskTerminal(taskId);
			clearMountedTerminal(terminalRef, previousSessionRef);
			setLastError(null);
			setIsLoading(false);
			setIsStopping(false);
			return;
		}

		if (!projectId) {
			releaseTaskTerminal(taskId);
			clearMountedTerminal(terminalRef, previousSessionRef);
			setLastError("No project selected.");
			setIsLoading(false);
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}

		// Ensure pooled task terminals are staged in this container.
		stageTaskTerminalContainer(container);

		const previousSession = previousSessionRef.current;
		const didSessionRestart =
			previousSession !== null &&
			previousSession.projectId === projectId &&
			previousSession.taskId === taskId &&
			previousSession.sessionStartedAt !== sessionStartedAt;

		const terminal = acquireTaskTerminal(taskId, projectId);
		if (didSessionRestart) {
			terminal.reset();
		}
		previousSessionRef.current = { projectId, taskId, sessionStartedAt };
		terminalRef.current = terminal;
		setLastError(null);
		setIsLoading(true);
		setIsStopping(false);
		const unsubscribe = terminal.subscribe({
			onConnectionReady: (connectedTaskId: string) => {
				setIsLoading(false);
				callbackRef.current.onConnectionReady?.(connectedTaskId);
			},
			onLastError: setLastError,
			onSummary: (summary: RuntimeTaskSessionSummary) => {
				callbackRef.current.onSummary?.(summary);
			},
			onExit: (exitTaskId: string, exitCode: number | null) => {
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
			requestRestore: () => {
				const terminal = terminalRef.current;
				if (!terminal) {
					return false;
				}
				terminal.requestRestore();
				return true;
			},
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

	const requestRestore = useCallback(() => {
		const terminal = terminalRef.current;
		if (!terminal) {
			return false;
		}
		terminal.requestRestore();
		return true;
	}, []);

	return {
		containerRef,
		lastError,
		isLoading,
		isStopping,
		clearTerminal,
		requestRestore,
		stopTerminal,
	};
}
