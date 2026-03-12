import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { registerTerminalController } from "@/terminal/terminal-controller-registry";
import { ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";

interface UsePersistentTerminalSessionInput {
	taskId: string;
	workspaceId: string | null;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
	autoFocus?: boolean;
	isVisible?: boolean;
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
	onSummary,
	onConnectionReady,
	autoFocus = false,
	isVisible = true,
	terminalBackgroundColor,
	cursorColor,
}: UsePersistentTerminalSessionInput): UsePersistentTerminalSessionResult {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<ReturnType<typeof ensurePersistentTerminal> | null>(null);
	const [lastError, setLastError] = useState<string | null>(null);
	const [isStopping, setIsStopping] = useState(false);

	useEffect(() => {
		if (!workspaceId) {
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			setLastError("No project selected.");
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const terminal = ensurePersistentTerminal({
			taskId,
			workspaceId,
			cursorColor,
			terminalBackgroundColor,
		});
		terminalRef.current = terminal;
		const unsubscribe = terminal.subscribe({
			onConnectionReady,
			onLastError: setLastError,
			onSummary,
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
	}, [autoFocus, cursorColor, isVisible, onConnectionReady, onSummary, taskId, terminalBackgroundColor, workspaceId]);

	useEffect(() => {
		return registerTerminalController(taskId, {
			input: (text) => terminalRef.current?.input(text) ?? false,
			paste: (text) => terminalRef.current?.paste(text) ?? false,
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
