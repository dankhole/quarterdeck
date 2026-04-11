import { useCallback, useEffect, useRef, useState } from "react";

import { ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";

const SNAPSHOT_INTERVAL_MS = 100;

interface UseChatOutputInput {
	taskId: string;
	workspaceId: string | null;
	enabled: boolean;
	terminalBackgroundColor: string;
	cursorColor: string;
}

export interface UseChatOutputResult {
	lines: string[];
	clear: () => void;
}

/**
 * Reads the terminal's rendered buffer content for HTML display.
 *
 * Instead of parsing the raw ANSI stream (which fails for full-screen TUIs
 * like Claude Code that use cursor positioning for all output), this hook
 * reads from xterm.js's already-processed buffer — the same content visible
 * in the terminal canvas, just as plain text lines.
 *
 * Snapshots are throttled to avoid excessive reads during fast output.
 */
export function useChatOutput({
	taskId,
	workspaceId,
	enabled,
	terminalBackgroundColor,
	cursorColor,
}: UseChatOutputInput): UseChatOutputResult {
	const [lines, setLines] = useState<string[]>([]);
	const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const terminalRef = useRef<ReturnType<typeof ensurePersistentTerminal> | null>(null);

	const snapshot = useCallback(() => {
		snapshotTimerRef.current = null;
		const terminal = terminalRef.current;
		if (!terminal) {
			return;
		}
		setLines(terminal.readBufferLines());
	}, []);

	const scheduleSnapshot = useCallback(() => {
		if (snapshotTimerRef.current !== null) {
			return;
		}
		snapshotTimerRef.current = setTimeout(snapshot, SNAPSHOT_INTERVAL_MS);
	}, [snapshot]);

	useEffect(() => {
		if (!enabled || !workspaceId) {
			terminalRef.current = null;
			return;
		}
		const terminal = ensurePersistentTerminal({
			taskId,
			workspaceId,
			cursorColor,
			terminalBackgroundColor,
		});
		terminalRef.current = terminal;

		// Take an initial snapshot to show existing buffer content
		setLines(terminal.readBufferLines());

		// Subscribe to output events to trigger re-snapshots
		const unsubscribe = terminal.subscribe({
			onOutputText: () => {
				scheduleSnapshot();
			},
		});
		return () => {
			unsubscribe();
			terminalRef.current = null;
			if (snapshotTimerRef.current !== null) {
				clearTimeout(snapshotTimerRef.current);
				snapshotTimerRef.current = null;
			}
		};
	}, [cursorColor, enabled, scheduleSnapshot, taskId, terminalBackgroundColor, workspaceId]);

	const clear = useCallback(() => {
		setLines([]);
	}, []);

	return { lines, clear };
}
