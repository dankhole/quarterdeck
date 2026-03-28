import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";

import type { RuntimeTerminalWsServerMessage } from "../core/api-contract";
import { parseTerminalWsClientMessage } from "../core/api-validation";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import type { TerminalSessionService } from "./terminal-session-service";

interface TerminalWebSocketConnectionContext {
	taskId: string;
	workspaceId: string;
	terminalManager: TerminalSessionService;
}

interface UpgradeRequest extends IncomingMessage {
	__kanbanUpgradeHandled?: boolean;
}

export interface CreateTerminalWebSocketBridgeRequest {
	server: Server;
	resolveTerminalManager: (workspaceId: string) => TerminalSessionService | null;
	isTerminalIoWebSocketPath: (pathname: string) => boolean;
	isTerminalControlWebSocketPath: (pathname: string) => boolean;
}

export interface TerminalWebSocketBridge {
	close: () => Promise<void>;
}

interface IoOutputState {
	enqueueOutput: (chunk: Buffer) => void;
	acknowledgeOutput: (bytes: number) => void;
	dispose: () => void;
}

interface TerminalStreamState {
	pendingOutputChunks: Buffer[];
	restoreComplete: boolean;
	controlConnected: boolean;
	ioState: IoOutputState | null;
	detachOutputListener: (() => void) | null;
	flushPendingOutput: () => void;
}

const OUTPUT_BATCH_INTERVAL_MS = 4;
const LOW_LATENCY_CHUNK_BYTES = 256;
const LOW_LATENCY_IDLE_WINDOW_MS = 5;
const OUTPUT_BUFFER_HIGH_WATER_MARK_BYTES = 16 * 1024;
const OUTPUT_BUFFER_LOW_WATER_MARK_BYTES = Math.floor(OUTPUT_BUFFER_HIGH_WATER_MARK_BYTES / 4);
const OUTPUT_ACK_HIGH_WATER_MARK_BYTES = 100_000;
const OUTPUT_ACK_LOW_WATER_MARK_BYTES = 5_000;
const OUTPUT_RESUME_CHECK_INTERVAL_MS = 16;

function getWebSocketTransportSocket(ws: WebSocket): Socket | null {
	const transportSocket = (ws as WebSocket & { _socket?: Socket })._socket;
	return transportSocket ?? null;
}

function rawDataToBuffer(message: RawData): Buffer {
	if (typeof message === "string") {
		return Buffer.from(message, "utf8");
	}
	if (Buffer.isBuffer(message)) {
		return message;
	}
	if (Array.isArray(message)) {
		return Buffer.concat(message.map((part) => rawDataToBuffer(part)));
	}
	return Buffer.from(message);
}

function parseWebSocketPayload(message: RawData) {
	try {
		const text = typeof message === "string" ? message : message.toString("utf8");
		const parsed = JSON.parse(text) as unknown;
		return parseTerminalWsClientMessage(parsed);
	} catch {
		return null;
	}
}

function sendControlMessage(ws: WebSocket, message: RuntimeTerminalWsServerMessage): void {
	if (ws.readyState !== ws.OPEN) {
		return;
	}
	ws.send(JSON.stringify(message));
}

function buildConnectionKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

export function createTerminalWebSocketBridge({
	server,
	resolveTerminalManager,
	isTerminalIoWebSocketPath,
	isTerminalControlWebSocketPath,
}: CreateTerminalWebSocketBridgeRequest): TerminalWebSocketBridge {
	const activeSockets = new Set<Socket>();
	const terminalStreamStates = new Map<string, TerminalStreamState>();
	server.on("connection", (socket: Socket) => {
		socket.setNoDelay(true);
		activeSockets.add(socket);
		socket.on("close", () => {
			activeSockets.delete(socket);
		});
	});

	const ioServer = new WebSocketServer({ noServer: true });
	const controlServer = new WebSocketServer({ noServer: true });

	const getOrCreateTerminalStreamState = (connectionKey: string): TerminalStreamState => {
		const existing = terminalStreamStates.get(connectionKey);
		if (existing) {
			return existing;
		}
		const created: TerminalStreamState = {
			pendingOutputChunks: [],
			restoreComplete: false,
			controlConnected: false,
			ioState: null,
			detachOutputListener: null,
			flushPendingOutput: () => {
				if (!created.restoreComplete || !created.ioState || created.pendingOutputChunks.length === 0) {
					return;
				}
				for (const chunk of created.pendingOutputChunks) {
					created.ioState.enqueueOutput(chunk);
				}
				created.pendingOutputChunks = [];
			},
		};
		terminalStreamStates.set(connectionKey, created);
		return created;
	};

	const cleanupTerminalStreamStateIfUnused = (connectionKey: string): void => {
		const state = terminalStreamStates.get(connectionKey);
		if (!state || state.controlConnected || state.ioState) {
			return;
		}
		state.detachOutputListener?.();
		state.detachOutputListener = null;
		terminalStreamStates.delete(connectionKey);
	};

	const createIoOutputState = (
		ws: WebSocket,
		taskId: string,
		terminalManager: TerminalSessionService,
	): IoOutputState => {
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
				terminalManager.resumeOutput(taskId);
				return;
			}
			scheduleResumeCheck();
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

		const checkBackpressureAfterSend = (chunk: Buffer) => {
			if (outputPaused || ws.readyState !== ws.OPEN) {
				return;
			}
			unacknowledgedOutputBytes += chunk.byteLength;
			if (shouldPauseOutput()) {
				outputPaused = true;
				terminalManager.pauseOutput(taskId);
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
					terminalManager.resumeOutput(taskId);
				}
				pendingOutputChunks = [];
			},
		};
	};

	server.on("upgrade", (request, socket, head) => {
		try {
			(socket as Socket).setNoDelay(true);
			const upgradeRequest = request as UpgradeRequest;
			const url = new URL(request.url ?? "/", getKanbanRuntimeOrigin());
			const pathname = url.pathname;
			const isIoRequest = isTerminalIoWebSocketPath(pathname);
			const isControlRequest = isTerminalControlWebSocketPath(pathname);
			if (!isIoRequest && !isControlRequest) {
				return;
			}
			upgradeRequest.__kanbanUpgradeHandled = true;

			const taskId = url.searchParams.get("taskId")?.trim();
			const workspaceId = url.searchParams.get("workspaceId")?.trim();
			if (!taskId || !workspaceId) {
				socket.destroy();
				return;
			}
			const terminalManager = resolveTerminalManager(workspaceId);
			if (!terminalManager) {
				socket.destroy();
				return;
			}

			const targetServer = isIoRequest ? ioServer : controlServer;
			targetServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
				targetServer.emit("connection", ws, { taskId, workspaceId, terminalManager });
			});
		} catch {
			socket.destroy();
		}
	});

	ioServer.on("connection", (ws: WebSocket, context: unknown) => {
		const taskId = (context as TerminalWebSocketConnectionContext).taskId;
		const workspaceId = (context as TerminalWebSocketConnectionContext).workspaceId;
		const terminalManager = (context as TerminalWebSocketConnectionContext).terminalManager;
		const connectionKey = buildConnectionKey(workspaceId, taskId);
		terminalManager.recoverStaleSession(taskId);
		const streamState = getOrCreateTerminalStreamState(connectionKey);
		streamState.ioState?.dispose();
		streamState.ioState = createIoOutputState(ws, taskId, terminalManager);
		streamState.flushPendingOutput();

		ws.on("message", (rawMessage: RawData) => {
			try {
				const summary = terminalManager.writeInput(taskId, rawDataToBuffer(rawMessage));
				if (!summary) {
					ws.close(1011, "Task session is not running.");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ws.close(1011, message);
			}
		});

		ws.on("close", () => {
			if (streamState.ioState) {
				streamState.ioState.dispose();
				streamState.ioState = null;
			}
			cleanupTerminalStreamStateIfUnused(connectionKey);
		});
	});

	controlServer.on("connection", (ws: WebSocket, context: unknown) => {
		const taskId = (context as TerminalWebSocketConnectionContext).taskId;
		const workspaceId = (context as TerminalWebSocketConnectionContext).workspaceId;
		const terminalManager = (context as TerminalWebSocketConnectionContext).terminalManager;
		const connectionKey = buildConnectionKey(workspaceId, taskId);
		terminalManager.recoverStaleSession(taskId);
		const streamState = getOrCreateTerminalStreamState(connectionKey);
		streamState.restoreComplete = false;
		streamState.controlConnected = true;
		streamState.pendingOutputChunks = [];
		streamState.detachOutputListener?.();
		streamState.detachOutputListener = terminalManager.attach(taskId, {
			onOutput: (chunk) => {
				if (streamState.restoreComplete && streamState.ioState) {
					streamState.ioState.enqueueOutput(chunk);
					return;
				}
				streamState.pendingOutputChunks.push(chunk);
			},
		});
		const detachControlListener = terminalManager.attach(taskId, {
			onState: (summary) => {
				sendControlMessage(ws, {
					type: "state",
					summary,
				});
			},
			onExit: (code) => {
				sendControlMessage(ws, {
					type: "exit",
					code,
				});
			},
		});

		void terminalManager
			.getRestoreSnapshot(taskId)
			.then((snapshot) => {
				sendControlMessage(ws, {
					type: "restore",
					snapshot: snapshot?.snapshot ?? "",
					cols: snapshot?.cols ?? null,
					rows: snapshot?.rows ?? null,
				});
			})
			.catch(() => {
				sendControlMessage(ws, {
					type: "restore",
					snapshot: "",
					cols: null,
					rows: null,
				});
			});

		ws.on("message", (rawMessage: RawData) => {
			const message = parseWebSocketPayload(rawMessage);
			if (!message) {
				sendControlMessage(ws, {
					type: "error",
					message: "Invalid terminal control payload.",
				});
				return;
			}

			if (message.type === "resize") {
				terminalManager.resize(taskId, message.cols, message.rows, message.pixelWidth, message.pixelHeight);
				return;
			}

			if (message.type === "stop") {
				terminalManager.stopTaskSession(taskId);
				return;
			}

			if (message.type === "output_ack") {
				streamState.ioState?.acknowledgeOutput(message.bytes);
				return;
			}

			if (message.type === "restore_complete") {
				streamState.restoreComplete = true;
				streamState.flushPendingOutput();
			}
		});

		ws.on("close", () => {
			detachControlListener?.();
			streamState.controlConnected = false;
			if (!streamState.ioState) {
				streamState.detachOutputListener?.();
				streamState.detachOutputListener = null;
			}
			cleanupTerminalStreamStateIfUnused(connectionKey);
		});
	});

	return {
		close: async () => {
			for (const client of ioServer.clients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			for (const client of controlServer.clients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			await new Promise<void>((resolveCloseWebSockets) => {
				ioServer.close(() => {
					controlServer.close(() => {
						resolveCloseWebSockets();
					});
				});
			});
			for (const socket of activeSockets) {
				try {
					socket.destroy();
				} catch {
					// Ignore socket destroy errors during shutdown.
				}
			}
		},
	};
}
