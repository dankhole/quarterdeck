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
	onSummary?: (projectId: string, summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
	onExit?: (taskId: string, exitCode: number | null) => void;
	autoFocus?: boolean;
	isVisible?: boolean;
	sessionStartedAt?: number | null;
	sessionInstanceId?: string | null;
	terminalBackgroundColor: string;
	cursorColor: string;
}

export interface UsePersistentTerminalSessionResult {
	containerRef: MutableRefObject<HTMLDivElement | null>;
	lastError: string | null;
	isLoading: boolean;
	isContentPending: boolean;
	isStopping: boolean;
	clearTerminal: () => void;
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
	sessionInstanceId = null,
	terminalBackgroundColor,
	cursorColor,
}: UsePersistentTerminalSessionInput): UsePersistentTerminalSessionResult {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<TaskTerminalHandle | null>(null);
	const callbackRef = useRef<{
		onSummary?: (projectId: string, summary: RuntimeTaskSessionSummary) => void;
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
	const [isContentPending, setIsContentPending] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	callbackRef.current = {
		onSummary,
		onConnectionReady,
		onExit,
	};

	// Appearance changes update the mounted viewer without replacing its sockets.
	const shellAppearanceRef = useRef({ cursorColor, terminalBackgroundColor });
	shellAppearanceRef.current = { cursorColor, terminalBackgroundColor };

	// The attachment controller reconnects on native PTY identity changes.
	// Replacing the viewer here races initial shell startup and replays autofocus.
	useEffect(() => {
		if (!isDedicatedTerminalTaskId(taskId)) {
			return;
		}
		setIsContentPending(false);
		if (!enabled || !isVisible || !projectId) {
			setLastError(enabled && isVisible && !projectId ? "No project selected." : null);
			setIsLoading(false);
			setIsStopping(false);
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const { cursorColor, terminalBackgroundColor } = shellAppearanceRef.current;
		const terminal = ensureDedicatedTerminal({
			taskId,
			projectId,
			cursorColor,
			terminalBackgroundColor,
		});
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
				callbackRef.current.onSummary?.(projectId, summary);
			},
			onExit: (exitTaskId: string, exitCode: number | null) => {
				callbackRef.current.onExit?.(exitTaskId, exitCode);
			},
		});
		terminal.attachToStageContainer(container);
		return () => {
			log.debug("disposing dedicated shell viewer", { taskId, projectId });
			unsubscribe();
			if (terminalRef.current === terminal) {
				terminalRef.current = null;
			}
			// Only browser resources are released. The runtime retains the shell
			// process and output; a fresh viewer restores them on reattachment.
			disposeDedicatedTerminal(projectId, taskId);
		};
	}, [enabled, isVisible, projectId, taskId]);

	useEffect(() => {
		if (isDedicatedTerminalTaskId(taskId)) {
			terminalRef.current?.show({ cursorColor, terminalBackgroundColor }, { autoFocus, isVisible });
		}
	}, [autoFocus, cursorColor, enabled, isVisible, projectId, taskId, terminalBackgroundColor]);

	useEffect(() => {
		if (isDedicatedTerminalTaskId(taskId)) {
			return;
		}
		setIsContentPending(false);

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
			// The control socket can observe the new pid/startedAt and finish its
			// reconnect restore before this React effect runs. Resetting afterward
			// would then erase the authoritative snapshot and leave the task pane
			// blank. Requesting a restore here is safe
			// in either order: the socket manager queues it behind an in-flight
			// restore, sends it after one already completed, or the reconnect's
			// upcoming initial restore supplies the same snapshot.
			terminal.requestRestore();
		}
		previousSessionRef.current = { projectId, taskId, sessionStartedAt };
		terminalRef.current = terminal;
		setLastError(null);
		setIsLoading(true);
		setIsStopping(false);
		const unsubscribe = terminal.subscribe({
			onContentPending: setIsContentPending,
			onConnectionReady: (connectedTaskId: string) => {
				setIsLoading(false);
				callbackRef.current.onConnectionReady?.(connectedTaskId);
			},
			onLastError: setLastError,
			onSummary: (summary: RuntimeTaskSessionSummary) => {
				callbackRef.current.onSummary?.(projectId, summary);
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
		if (!projectId || !sessionInstanceId || !enabled || (isDedicatedTerminalTaskId(taskId) && !isVisible)) {
			return;
		}
		const terminal = terminalRef.current;
		if (!terminal) {
			return;
		}
		let active = true;
		let ready = false;
		const unregister = registerTerminalController(
			taskId,
			{
				input: (text) => (active && ready ? terminal.input(text) : false),
				paste: (text) => (active && ready ? terminal.paste(text) : false),
				focus: () => {
					if (active) terminal.focus();
				},
				waitForLikelyPrompt: async (timeoutMs) =>
					active && ready && (await terminal.waitForLikelyPrompt(timeoutMs)) && active && ready,
			},
			{ projectId, sessionInstanceId, sessionStartedAt },
			(onReadyChange) => {
				let transportReady = false;
				let transportSessionInstanceId: string | null = null;
				const updateReadiness = () => {
					ready = transportReady && transportSessionInstanceId === sessionInstanceId;
					onReadyChange(ready);
				};
				return terminal.subscribe({
					onSummary: (summary) => {
						transportSessionInstanceId = summary.sessionInstanceId ?? null;
						updateReadiness();
					},
					onConnectionReady: () => {
						transportReady = true;
						updateReadiness();
					},
				});
			},
		);
		return () => {
			active = false;
			unregister();
		};
	}, [enabled, isVisible, projectId, sessionInstanceId, sessionStartedAt, taskId]);

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
		isContentPending,
		isStopping,
		clearTerminal,
		stopTerminal,
	};
}
