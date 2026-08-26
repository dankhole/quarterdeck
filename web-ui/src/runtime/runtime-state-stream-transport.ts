import { normalizeDiagnosticErrorClass } from "@runtime-contract";
import { noteBrowserRuntimeReconnect, recordBrowserEvent, setBrowserDiagnosticsConnected } from "@/diagnostics";
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
	url.searchParams.set("browserBuildId", __QUARTERDECK_BUILD_ID__);
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
	acceptCurrentConnection: () => void;
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
	let socketOpen = false;
	let connectionAccepted = false;

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
		socketOpen = false;
		connectionAccepted = false;
	};

	const scheduleReconnect = () => {
		if (cancelled || reconnectTimer !== null) {
			return;
		}

		const delay = Math.min(STREAM_RECONNECT_MAX_DELAY_MS, STREAM_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt);
		reconnectAttempt += 1;
		noteBrowserRuntimeReconnect(reconnectAttempt, delay);
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
			const connectedSocket = new WebSocket(getRuntimeStreamUrl(connectionProjectId));
			socket = connectedSocket;
			disconnectReportedForSocket = false;
			socketOpen = false;
			connectionAccepted = false;
			const isCurrentConnection = (): boolean => !cancelled && socket === connectedSocket;

			connectedSocket.onopen = () => {
				if (!isCurrentConnection()) {
					return;
				}
				socketOpen = true;
			};

			connectedSocket.onmessage = (event) => {
				if (!isCurrentConnection()) {
					return;
				}
				try {
					const payload = JSON.parse(String(event.data)) as RuntimeStateStreamMessage;
					if (!connectionAccepted && payload.type !== "snapshot") {
						return;
					}
					callbacks.onMessage(payload);
				} catch (error) {
					log.warn("Malformed stream message", error);
					recordBrowserEvent(
						"browser.runtime_message_rejected",
						{
							errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
						},
						{},
						{ level: "warn", essential: true },
					);
				}
			};

			connectedSocket.onclose = () => {
				if (!isCurrentConnection()) {
					return;
				}
				setRuntimeDisconnected(true);
				setBrowserDiagnosticsConnected(false, "Runtime stream disconnected.");
				if (!disconnectReportedForSocket) {
					disconnectReportedForSocket = true;
					callbacks.onDisconnected("Runtime stream disconnected.");
				}
				scheduleReconnect();
			};

			connectedSocket.onerror = () => {
				if (!isCurrentConnection()) {
					return;
				}
				setRuntimeDisconnected(true);
				setBrowserDiagnosticsConnected(false, "Runtime stream connection failed.");
				log.error("WebSocket connection failed");
				if (!disconnectReportedForSocket) {
					disconnectReportedForSocket = true;
					callbacks.onDisconnected("Runtime stream connection failed.");
				}
			};
		} catch (error) {
			setRuntimeDisconnected(true);
			setBrowserDiagnosticsConnected(false, toErrorMessage(error));
			callbacks.onDisconnected(toErrorMessage(error));
			scheduleReconnect();
			return;
		}
	};

	connect();

	return {
		acceptCurrentConnection() {
			if (cancelled || !socket || !socketOpen || connectionAccepted) {
				return;
			}
			connectionAccepted = true;
			reconnectAttempt = 0;
			setRuntimeDisconnected(false);
			setBrowserDiagnosticsConnected(true);
			callbacks.onConnected();
		},
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
