import { getRuntimeBrowserClientId } from "@/runtime/runtime-client-id";
import { setRuntimeDisconnected } from "@/runtime/runtime-connection-state";
import type { RuntimeStateStreamMessage } from "@/runtime/types";
import { createClientLogger } from "@/utils/client-logger";
import { toErrorMessage } from "@/utils/to-error-message";

const log = createClientLogger("ws-stream");

const STREAM_RECONNECT_BASE_DELAY_MS = 500;
const STREAM_RECONNECT_MAX_DELAY_MS = 5_000;

function getRuntimeStreamUrl(projectId: string | null): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/runtime/ws`);
	if (projectId) {
		url.searchParams.set("projectId", projectId);
	}
	url.searchParams.set("clientId", getRuntimeBrowserClientId());
	url.searchParams.set("documentVisible", String(readCurrentDocumentVisible()));
	return url.toString();
}

function readCurrentDocumentVisible(): boolean {
	if (typeof document === "undefined") {
		return true;
	}
	return document.visibilityState === "visible";
}

export interface RuntimeStateStreamTransportCallbacks {
	onConnected: () => void;
	onDisconnected: (message: string) => void;
	onMessage: (payload: RuntimeStateStreamMessage) => void;
}

export interface RuntimeStateStreamTransport {
	switchProject: (projectId: string | null) => void;
	dispose: () => void;
}

export function startRuntimeStateStreamTransport(
	requestedProjectId: string | null,
	callbacks: RuntimeStateStreamTransportCallbacks,
): RuntimeStateStreamTransport {
	let cancelled = false;
	let socket: WebSocket | null = null;
	let reconnectTimer: number | null = null;
	let reconnectAttempt = 0;
	let connectionProjectId = requestedProjectId;
	let disconnectReportedForSocket = false;

	const cleanupSocket = () => {
		if (!socket) {
			return;
		}
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		socket.close();
		socket = null;
	};

	const scheduleReconnect = () => {
		if (cancelled || reconnectTimer !== null) {
			return;
		}

		const delay = Math.min(STREAM_RECONNECT_MAX_DELAY_MS, STREAM_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt);
		reconnectAttempt += 1;
		reconnectTimer = window.setTimeout(() => {
			connect();
		}, delay);
	};

	const connect = () => {
		if (cancelled) {
			return;
		}
		if (reconnectTimer !== null) {
			window.clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		cleanupSocket();

		try {
			socket = new WebSocket(getRuntimeStreamUrl(connectionProjectId));
			disconnectReportedForSocket = false;
		} catch (error) {
			setRuntimeDisconnected(true);
			callbacks.onDisconnected(toErrorMessage(error));
			scheduleReconnect();
			return;
		}

		socket.onopen = () => {
			reconnectAttempt = 0;
			setRuntimeDisconnected(false);
			callbacks.onConnected();
		};

		socket.onmessage = (event) => {
			try {
				callbacks.onMessage(JSON.parse(String(event.data)) as RuntimeStateStreamMessage);
			} catch (error) {
				log.warn("Malformed stream message", error);
			}
		};

		socket.onclose = () => {
			if (cancelled) {
				return;
			}
			setRuntimeDisconnected(true);
			if (!disconnectReportedForSocket) {
				disconnectReportedForSocket = true;
				callbacks.onDisconnected("Runtime stream disconnected.");
			}
			scheduleReconnect();
		};

		socket.onerror = () => {
			if (cancelled) {
				return;
			}
			setRuntimeDisconnected(true);
			log.error("WebSocket connection failed");
			if (!disconnectReportedForSocket) {
				disconnectReportedForSocket = true;
				callbacks.onDisconnected("Runtime stream connection failed.");
			}
		};
	};

	connect();

	return {
		switchProject(projectId) {
			connectionProjectId = projectId;
			reconnectAttempt = 0;
			connect();
		},
		dispose() {
			cancelled = true;
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer);
			}
			cleanupSocket();
		},
	};
}
