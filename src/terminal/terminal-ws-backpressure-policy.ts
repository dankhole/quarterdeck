import type { WebSocket } from "ws";

import type { TerminalSessionService } from "./terminal-session-service";
import { getWebSocketTransportSocket } from "./terminal-ws-protocol";
import type { IoOutputState, TerminalStreamState } from "./terminal-ws-types";

const OUTPUT_BATCH_INTERVAL_MS = 4;
const LOW_LATENCY_CHUNK_BYTES = 256;
const LOW_LATENCY_IDLE_WINDOW_MS = 5;
const OUTPUT_BUFFER_HIGH_WATER_MARK_BYTES = 16 * 1024;
const OUTPUT_BUFFER_LOW_WATER_MARK_BYTES = Math.floor(OUTPUT_BUFFER_HIGH_WATER_MARK_BYTES / 4);
const OUTPUT_ACK_HIGH_WATER_MARK_BYTES = 100_000;
const OUTPUT_ACK_LOW_WATER_MARK_BYTES = 5_000;
const OUTPUT_RESUME_CHECK_INTERVAL_MS = 16;

interface CreateIoOutputStateRequest {
	ws: WebSocket;
	streamState: TerminalStreamState;
	clientId: string;
	taskId: string;
	terminalManager: TerminalSessionService;
	onBackpressureChanged?: (paused: boolean, metrics: { bufferedBytes: number; unacknowledgedBytes: number }) => void;
}

export function createTerminalWsIoOutputState({
	ws,
	streamState,
	clientId,
	taskId,
	terminalManager,
	onBackpressureChanged,
}: CreateIoOutputStateRequest): IoOutputState {
	let disposed = false;
	const drainWaiters = new Set<(drained: boolean) => void>();
	let pendingOutputChunks: Buffer[] = [];
	let outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
	let lastOutputSentAt = 0;
	let outputPaused = false;
	let resumeCheckTimer: ReturnType<typeof setTimeout> | null = null;
	let unacknowledgedOutputBytes = 0;

	const shouldPauseOutput = () =>
		ws.bufferedAmount >= OUTPUT_BUFFER_HIGH_WATER_MARK_BYTES ||
		unacknowledgedOutputBytes >= OUTPUT_ACK_HIGH_WATER_MARK_BYTES;

	const canResumeOutput = () =>
		ws.bufferedAmount < OUTPUT_BUFFER_LOW_WATER_MARK_BYTES &&
		unacknowledgedOutputBytes < OUTPUT_ACK_LOW_WATER_MARK_BYTES;

	const clearResumeCheck = () => {
		if (resumeCheckTimer !== null) {
			clearTimeout(resumeCheckTimer);
			resumeCheckTimer = null;
		}
		const transportSocket = getWebSocketTransportSocket(ws);
		transportSocket?.removeListener("drain", checkResumeAfterBackpressure);
	};

	const scheduleResumeCheck = () => {
		if (!outputPaused) {
			return;
		}
		clearResumeCheck();
		const transportSocket = getWebSocketTransportSocket(ws);
		transportSocket?.once("drain", checkResumeAfterBackpressure);
		resumeCheckTimer = setTimeout(() => {
			resumeCheckTimer = null;
			checkResumeAfterBackpressure();
		}, OUTPUT_RESUME_CHECK_INTERVAL_MS);
	};

	const checkResumeAfterBackpressure = () => {
		if (!outputPaused) {
			clearResumeCheck();
			return;
		}
		if (ws.readyState !== ws.OPEN) {
			return;
		}
		if (canResumeOutput()) {
			outputPaused = false;
			onBackpressureChanged?.(false, {
				bufferedBytes: ws.bufferedAmount,
				unacknowledgedBytes: unacknowledgedOutputBytes,
			});
			clearResumeCheck();
			streamState.backpressuredViewerIds.delete(clientId);
			if (streamState.backpressuredViewerIds.size === 0) {
				terminalManager.resumeOutput(taskId);
			}
			return;
		}
		scheduleResumeCheck();
	};

	const checkBackpressureAfterSend = () => {
		if (disposed || outputPaused || ws.readyState !== ws.OPEN) {
			return;
		}
		if (shouldPauseOutput()) {
			outputPaused = true;
			onBackpressureChanged?.(true, {
				bufferedBytes: ws.bufferedAmount,
				unacknowledgedBytes: unacknowledgedOutputBytes,
			});
			const previouslyPaused = streamState.backpressuredViewerIds.size > 0;
			streamState.backpressuredViewerIds.add(clientId);
			if (!previouslyPaused) {
				terminalManager.pauseOutput(taskId);
			}
			scheduleResumeCheck();
		}
	};

	const sendOutputChunk = (chunk: Buffer) => {
		if (disposed || ws.readyState !== ws.OPEN) {
			return;
		}
		// Count every frame, including output emitted while already paused.
		// Reserve before send so a synchronous ack/disposal cannot race it.
		unacknowledgedOutputBytes += chunk.byteLength;
		ws.send(chunk);
		lastOutputSentAt = Date.now();
		checkBackpressureAfterSend();
	};

	const flushOutputBatch = () => {
		outputFlushTimer = null;
		if (pendingOutputChunks.length === 0 || ws.readyState !== ws.OPEN) {
			pendingOutputChunks = [];
			return;
		}
		const chunks = pendingOutputChunks;
		pendingOutputChunks = [];
		sendOutputChunk(Buffer.concat(chunks));
	};

	const settleDrainWaiters = (drained: boolean) => {
		const waiters = [...drainWaiters];
		drainWaiters.clear();
		for (const settle of waiters) settle(drained);
	};

	return {
		enqueueOutput: (chunk: Buffer) => {
			if (disposed) return;
			const now = Date.now();
			const shouldSendImmediately =
				pendingOutputChunks.length === 0 &&
				outputFlushTimer === null &&
				chunk.byteLength <= LOW_LATENCY_CHUNK_BYTES &&
				now - lastOutputSentAt >= LOW_LATENCY_IDLE_WINDOW_MS;
			if (shouldSendImmediately) {
				sendOutputChunk(chunk);
				return;
			}
			pendingOutputChunks.push(chunk);
			if (outputFlushTimer === null) {
				outputFlushTimer = setTimeout(flushOutputBatch, OUTPUT_BATCH_INTERVAL_MS);
			}
		},
		acknowledgeOutput: (bytes: number) => {
			unacknowledgedOutputBytes = Math.max(0, unacknowledgedOutputBytes - Math.max(0, Math.floor(bytes)));
			checkResumeAfterBackpressure();
			if (unacknowledgedOutputBytes === 0 && pendingOutputChunks.length === 0) settleDrainWaiters(true);
		},
		drainOutput: () => {
			if (disposed || ws.readyState !== ws.OPEN) return Promise.resolve(false);
			if (outputFlushTimer !== null) {
				clearTimeout(outputFlushTimer);
				outputFlushTimer = null;
			}
			flushOutputBatch();
			if (disposed || ws.readyState !== ws.OPEN) return Promise.resolve(false);
			if (unacknowledgedOutputBytes === 0 && pendingOutputChunks.length === 0) return Promise.resolve(true);
			return new Promise<boolean>((resolve) => drainWaiters.add(resolve));
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			settleDrainWaiters(false);
			if (outputFlushTimer !== null) {
				clearTimeout(outputFlushTimer);
				outputFlushTimer = null;
			}
			clearResumeCheck();
			if (outputPaused) {
				outputPaused = false;
				streamState.backpressuredViewerIds.delete(clientId);
				if (streamState.backpressuredViewerIds.size === 0) {
					terminalManager.resumeOutput(taskId);
				}
			}
			pendingOutputChunks = [];
		},
	};
}
