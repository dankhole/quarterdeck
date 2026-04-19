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
}

export function createTerminalWsIoOutputState({
	ws,
	streamState,
	clientId,
	taskId,
	terminalManager,
}: CreateIoOutputStateRequest): IoOutputState {
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
			clearResumeCheck();
			streamState.backpressuredViewerIds.delete(clientId);
			if (streamState.backpressuredViewerIds.size === 0) {
				terminalManager.resumeOutput(taskId);
			}
			return;
		}
		scheduleResumeCheck();
	};

	const checkBackpressureAfterSend = (chunk: Buffer) => {
		if (outputPaused || ws.readyState !== ws.OPEN) {
			return;
		}
		unacknowledgedOutputBytes += chunk.byteLength;
		if (shouldPauseOutput()) {
			outputPaused = true;
			const previouslyPaused = streamState.backpressuredViewerIds.size > 0;
			streamState.backpressuredViewerIds.add(clientId);
			if (!previouslyPaused) {
				terminalManager.pauseOutput(taskId);
			}
			scheduleResumeCheck();
		}
	};

	const sendOutputChunk = (chunk: Buffer) => {
		if (ws.readyState !== ws.OPEN) {
			return;
		}
		ws.send(chunk);
		lastOutputSentAt = Date.now();
		checkBackpressureAfterSend(chunk);
	};

	const flushOutputBatch = () => {
		outputFlushTimer = null;
		if (pendingOutputChunks.length === 0 || ws.readyState !== ws.OPEN) {
			pendingOutputChunks = [];
			return;
		}
		sendOutputChunk(Buffer.concat(pendingOutputChunks));
		pendingOutputChunks = [];
	};

	return {
		enqueueOutput: (chunk: Buffer) => {
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
		},
		dispose: () => {
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
