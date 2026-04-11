import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatOutputAccumulator } from "@/terminal/chat-output-accumulator";
import { createChatOutputAccumulator } from "@/terminal/chat-output-accumulator";
import { ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";

const BATCH_INTERVAL_MS = 60;

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
 * Subscribes to a persistent terminal's output text stream and accumulates
 * clean, ANSI-stripped lines for HTML rendering.
 *
 * Batches updates to avoid excessive React re-renders during fast output.
 */
export function useChatOutput({
	taskId,
	workspaceId,
	enabled,
	terminalBackgroundColor,
	cursorColor,
}: UseChatOutputInput): UseChatOutputResult {
	const [lines, setLines] = useState<string[]>([]);
	const accumulatorRef = useRef<ChatOutputAccumulator>(createChatOutputAccumulator());
	const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flush = useCallback(() => {
		batchTimerRef.current = null;
		setLines(accumulatorRef.current.getLines());
	}, []);

	const scheduleBatchFlush = useCallback(() => {
		if (batchTimerRef.current !== null) {
			return;
		}
		batchTimerRef.current = setTimeout(flush, BATCH_INTERVAL_MS);
	}, [flush]);

	useEffect(() => {
		if (!enabled || !workspaceId) {
			return;
		}
		// ensurePersistentTerminal returns the existing instance for this task if
		// one is already managed by the terminal session hook.
		const terminal = ensurePersistentTerminal({
			taskId,
			workspaceId,
			cursorColor,
			terminalBackgroundColor,
		});
		const unsubscribe = terminal.subscribe({
			onOutputText: (text) => {
				accumulatorRef.current.push(text);
				scheduleBatchFlush();
			},
		});
		return () => {
			unsubscribe();
			if (batchTimerRef.current !== null) {
				clearTimeout(batchTimerRef.current);
				batchTimerRef.current = null;
			}
		};
	}, [cursorColor, enabled, scheduleBatchFlush, taskId, terminalBackgroundColor, workspaceId]);

	const clear = useCallback(() => {
		accumulatorRef.current.clear();
		setLines([]);
	}, []);

	return { lines, clear };
}
