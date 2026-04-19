import type { Server } from "node:http";
import type { Socket } from "node:net";

import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { getQuarterdeckRuntimeOrigin } from "../core";
import type { TerminalSessionService } from "./terminal-session-service";
import { createTerminalWsIoOutputState } from "./terminal-ws-backpressure-policy";
import { TerminalWsConnectionRegistry } from "./terminal-ws-connection-registry";
import { ensureTerminalWsOutputListener } from "./terminal-ws-output-fanout";
import {
	buildConnectionKey,
	getTerminalClientId,
	parseTerminalControlMessage,
	rawDataToBuffer,
	sendControlMessage,
	type TerminalWebSocketConnectionContext,
	type UpgradeRequest,
} from "./terminal-ws-protocol";
import { TerminalWsRestoreCoordinator } from "./terminal-ws-restore-coordinator";

export interface CreateTerminalWebSocketBridgeRequest {
	server: Server;
	resolveTerminalManager: (projectId: string) => TerminalSessionService | null;
	isTerminalIoWebSocketPath: (pathname: string) => boolean;
	isTerminalControlWebSocketPath: (pathname: string) => boolean;
}

export interface TerminalWebSocketBridge {
	close: () => Promise<void>;
}

export function createTerminalWebSocketBridge({
	server,
	resolveTerminalManager,
	isTerminalIoWebSocketPath,
	isTerminalControlWebSocketPath,
}: CreateTerminalWebSocketBridgeRequest): TerminalWebSocketBridge {
	const activeSockets = new Set<Socket>();
	const registry = new TerminalWsConnectionRegistry();
	const restoreCoordinator = new TerminalWsRestoreCoordinator();
	server.on("connection", (socket: Socket) => {
		socket.setNoDelay(true);
		activeSockets.add(socket);
		socket.on("close", () => {
			activeSockets.delete(socket);
		});
	});

	const ioServer = new WebSocketServer({ noServer: true });
	const controlServer = new WebSocketServer({ noServer: true });

	server.on("upgrade", (request, socket, head) => {
		try {
			(socket as Socket).setNoDelay(true);
			const upgradeRequest = request as UpgradeRequest;
			const url = new URL(request.url ?? "/", getQuarterdeckRuntimeOrigin());
			const pathname = url.pathname;
			const isIoRequest = isTerminalIoWebSocketPath(pathname);
			const isControlRequest = isTerminalControlWebSocketPath(pathname);
			if (!isIoRequest && !isControlRequest) {
				return;
			}
			upgradeRequest.__quarterdeckUpgradeHandled = true;

			const taskId = url.searchParams.get("taskId")?.trim();
			const projectId = url.searchParams.get("projectId")?.trim();
			if (!taskId || !projectId) {
				socket.destroy();
				return;
			}
			const terminalManager = resolveTerminalManager(projectId);
			if (!terminalManager) {
				socket.destroy();
				return;
			}

			const targetServer = isIoRequest ? ioServer : controlServer;
			const clientId = getTerminalClientId(url);
			targetServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
				targetServer.emit("connection", ws, { taskId, projectId, clientId, terminalManager });
			});
		} catch {
			socket.destroy();
		}
	});

	ioServer.on("connection", (ws: WebSocket, context: unknown) => {
		const taskId = (context as TerminalWebSocketConnectionContext).taskId;
		const projectId = (context as TerminalWebSocketConnectionContext).projectId;
		const clientId = (context as TerminalWebSocketConnectionContext).clientId;
		const terminalManager = (context as TerminalWebSocketConnectionContext).terminalManager;
		const connectionKey = buildConnectionKey(projectId, taskId);
		terminalManager.recoverStaleSession(taskId);
		const { streamState, viewerState } = registry.getOrCreateViewer(connectionKey, clientId);
		const ioState = createTerminalWsIoOutputState({
			ws,
			streamState,
			clientId,
			taskId,
			terminalManager,
		});
		const previousIoSocket = registry.replaceIoConnection(viewerState, ws, ioState);
		restoreCoordinator.onIoSocketConnected(viewerState);
		ensureTerminalWsOutputListener({ streamState, taskId, terminalManager, restoreCoordinator });
		if (previousIoSocket && previousIoSocket !== ws) {
			previousIoSocket.close(1000, "Replaced by newer terminal stream.");
		}

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
			registry.detachIoSocket(connectionKey, viewerState, ws);
		});
	});

	controlServer.on("connection", (ws: WebSocket, context: unknown) => {
		const taskId = (context as TerminalWebSocketConnectionContext).taskId;
		const projectId = (context as TerminalWebSocketConnectionContext).projectId;
		const clientId = (context as TerminalWebSocketConnectionContext).clientId;
		const terminalManager = (context as TerminalWebSocketConnectionContext).terminalManager;
		const connectionKey = buildConnectionKey(projectId, taskId);
		terminalManager.recoverStaleSession(taskId);
		const { streamState, viewerState } = registry.getOrCreateViewer(connectionKey, clientId);
		// If this client is replacing an in-flight control socket, drop the old
		// socket's deferred restore timer before we transfer connection ownership.
		restoreCoordinator.clearDeferredSnapshot(viewerState);
		const previousControlSocket = registry.replaceControlConnection(viewerState, ws);
		ensureTerminalWsOutputListener({ streamState, taskId, terminalManager, restoreCoordinator });
		registry.replaceControlListener(
			viewerState,
			terminalManager.attach(taskId, {
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
			}),
		);
		if (previousControlSocket && previousControlSocket !== ws) {
			previousControlSocket.close(1000, "Replaced by newer terminal control connection.");
		}
		restoreCoordinator.beginInitialRestore({ viewerState, ws, terminalManager, taskId });

		ws.on("message", (rawMessage: RawData) => {
			const message = parseTerminalControlMessage(rawMessage);
			if (!message) {
				sendControlMessage(ws, {
					type: "error",
					message: "Invalid terminal control payload.",
				});
				return;
			}

			if (message.type === "resize") {
				restoreCoordinator.handleResize({
					viewerState,
					ws,
					terminalManager,
					taskId,
					cols: message.cols,
					rows: message.rows,
					pixelWidth: message.pixelWidth,
					pixelHeight: message.pixelHeight,
					force: message.force,
				});
				return;
			}

			if (message.type === "stop") {
				terminalManager.stopTaskSession(taskId);
				return;
			}

			if (message.type === "output_ack") {
				viewerState.ioState?.acknowledgeOutput(message.bytes);
				return;
			}

			if (message.type === "request_restore") {
				restoreCoordinator.requestRestore({ viewerState, ws, terminalManager, taskId });
				return;
			}

			if (message.type === "restore_complete") {
				restoreCoordinator.completeRestore(viewerState);
			}
		});

		ws.on("close", () => {
			restoreCoordinator.clearDeferredSnapshot(viewerState, ws);
			registry.detachControlSocket(connectionKey, viewerState, ws);
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
