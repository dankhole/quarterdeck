import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import type { RawData, WebSocket } from "ws";

import type { RuntimeTerminalWsClientMessage, RuntimeTerminalWsServerMessage } from "../core";
import { parseTerminalWsClientMessage } from "../core";
import type { TerminalSessionService } from "./terminal-session-service";

export const SNAPSHOT_DEFER_TIMEOUT_MS = 100;

export interface TerminalWebSocketConnectionContext {
	taskId: string;
	projectId: string;
	clientId: string;
	terminalManager: TerminalSessionService;
}

export interface UpgradeRequest extends IncomingMessage {
	__quarterdeckUpgradeHandled?: boolean;
}

export function buildConnectionKey(projectId: string, taskId: string): string {
	return `${projectId}:${taskId}`;
}

export function getTerminalClientId(url: URL): string {
	return url.searchParams.get("clientId")?.trim() || "legacy";
}

export function getWebSocketTransportSocket(ws: WebSocket): Socket | null {
	const transportSocket = (ws as WebSocket & { _socket?: Socket })._socket;
	return transportSocket ?? null;
}

export function rawDataToBuffer(message: RawData): Buffer {
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

export function parseTerminalControlMessage(message: RawData): RuntimeTerminalWsClientMessage | null {
	try {
		const text = typeof message === "string" ? message : message.toString("utf8");
		const parsed = JSON.parse(text) as unknown;
		return parseTerminalWsClientMessage(parsed);
	} catch {
		return null;
	}
}

export function sendControlMessage(ws: WebSocket, message: RuntimeTerminalWsServerMessage): void {
	if (ws.readyState !== ws.OPEN) {
		return;
	}
	ws.send(JSON.stringify(message));
}
