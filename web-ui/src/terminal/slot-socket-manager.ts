import type { RuntimeTerminalWsClientMessage, RuntimeTerminalWsServerMessage } from "@/runtime/types";
import {
	decodeTerminalSocketChunk,
	getTerminalSocketChunkByteLength,
	getTerminalSocketWriteData,
	getTerminalWebSocketUrl,
} from "@/terminal/terminal-socket-utils";
import { createClientLogger } from "@/utils/client-logger";

const log = createClientLogger("slot-socket");

interface SlotSocketCallbacks {
	enqueueWrite: (data: string | Uint8Array, options?: { ackBytes?: number; notifyText?: string | null }) => void;
	onRestore: (snapshot: string, cols: number | null | undefined, rows: number | null | undefined) => Promise<void>;
	onState: (payload: RuntimeTerminalWsServerMessage & { type: "state" }) => void;
	onExit: (code: number | null) => void;
	onError: (message: string) => void;
	onConnectionReady: () => void;
	onLastError: (message: string | null) => void;
	ensureVisible: () => void;
	invalidateResize: () => void;
	requestResize: () => void;
	getVisibleContainer: () => HTMLDivElement | null;
	getStageContainer: () => HTMLDivElement | null;
	isDisposed: () => boolean;
}

export class SlotSocketManager {
	private ioSocket: WebSocket | null = null;
	private controlSocket: WebSocket | null = null;
	private outputTextDecoder = new TextDecoder();
	private pendingRestoreRequest = false;
	connectionReady = false;
	restoreCompleted = false;

	constructor(
		private readonly slotId: number,
		private readonly clientId: string,
		private readonly callbacks: SlotSocketCallbacks,
	) {}

	get hasIoSocket(): boolean {
		return this.ioSocket !== null;
	}

	get hasControlSocket(): boolean {
		return this.controlSocket !== null;
	}

	get isIoOpen(): boolean {
		return this.ioSocket !== null && this.ioSocket.readyState === WebSocket.OPEN;
	}

	sendControl(message: RuntimeTerminalWsClientMessage): boolean {
		if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.controlSocket.send(JSON.stringify(message));
		return true;
	}

	sendIo(data: string | Uint8Array): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.ioSocket.send(data);
		return true;
	}

	connectIo(taskId: string, projectId: string): void {
		if (this.ioSocket) {
			return;
		}
		const t0 = performance.now();
		const ioSocket = new WebSocket(getTerminalWebSocketUrl("io", taskId, projectId, this.clientId));
		ioSocket.binaryType = "arraybuffer";
		ioSocket.addEventListener("message", (event) => {
			if (this.callbacks.isDisposed() || this.ioSocket !== ioSocket) {
				return;
			}
			const writeData = getTerminalSocketWriteData(event.data);
			if (!writeData) {
				return;
			}
			const decoded = decodeTerminalSocketChunk(this.outputTextDecoder, event.data);
			this.callbacks.enqueueWrite(writeData, {
				ackBytes: getTerminalSocketChunkByteLength(event.data),
				notifyText: decoded || null,
			});
		});
		this.ioSocket = ioSocket;
		ioSocket.onopen = () => {
			if (this.callbacks.isDisposed() || this.ioSocket !== ioSocket) {
				return;
			}
			log.debug(`[perf] slot ${this.slotId} IO socket open`, { elapsedMs: (performance.now() - t0).toFixed(1) });
			this.callbacks.onLastError(null);
			this.callbacks.invalidateResize();
			if (this.restoreCompleted && this.callbacks.getVisibleContainer()) {
				this.callbacks.requestResize();
			}
			if (this.restoreCompleted) {
				this.callbacks.onConnectionReady();
			}
		};
		ioSocket.onerror = () => {
			if (this.callbacks.isDisposed() || this.ioSocket !== ioSocket) {
				return;
			}
			this.callbacks.ensureVisible();
			this.callbacks.onLastError("Terminal stream failed.");
		};
		ioSocket.onclose = () => {
			if (this.callbacks.isDisposed() || this.ioSocket !== ioSocket) {
				return;
			}
			this.callbacks.ensureVisible();
			this.ioSocket = null;
			this.outputTextDecoder = new TextDecoder();
			this.connectionReady = false;
			this.restoreCompleted = false;
			this.pendingRestoreRequest = false;
			this.callbacks.onLastError("Terminal stream closed. Close and reopen to reconnect.");
		};
	}

	connectControl(taskId: string, projectId: string): void {
		if (this.controlSocket) {
			return;
		}
		const t0 = performance.now();
		const controlSocket = new WebSocket(getTerminalWebSocketUrl("control", taskId, projectId, this.clientId));
		this.controlSocket = controlSocket;
		controlSocket.onopen = () => {
			if (this.callbacks.isDisposed() || this.controlSocket !== controlSocket) {
				return;
			}
			log.debug(`[perf] slot ${this.slotId} control socket open`, {
				elapsedMs: (performance.now() - t0).toFixed(1),
			});
			this.callbacks.onLastError(null);
			this.callbacks.invalidateResize();
			this.callbacks.requestResize();
		};
		controlSocket.onmessage = (event) => {
			let payload: RuntimeTerminalWsServerMessage;
			try {
				payload = JSON.parse(String(event.data)) as RuntimeTerminalWsServerMessage;
			} catch {
				return;
			}

			if (payload.type === "restore") {
				this.restoreCompleted = false;
				void this.callbacks
					.onRestore(payload.snapshot, payload.cols, payload.rows)
					.then(() => {
						if (this.callbacks.isDisposed() || this.controlSocket !== controlSocket) {
							return;
						}
						this.markRestoreCompleted();
					})
					.catch(() => {
						if (this.callbacks.isDisposed() || this.controlSocket !== controlSocket) {
							return;
						}
						this.callbacks.ensureVisible();
						this.callbacks.onLastError("Terminal restore failed.");
					});
				return;
			}
			if (payload.type === "state") {
				this.callbacks.onState(payload);
				return;
			}
			if (payload.type === "exit") {
				this.callbacks.onExit(payload.code);
				return;
			}
			if (payload.type === "error") {
				this.callbacks.onLastError(payload.message);
				this.callbacks.onError(payload.message);
			}
		};
		controlSocket.onerror = () => {
			if (this.callbacks.isDisposed() || this.controlSocket !== controlSocket) {
				return;
			}
			this.callbacks.ensureVisible();
			this.callbacks.onLastError("Terminal control connection failed.");
		};
		controlSocket.onclose = () => {
			if (this.callbacks.isDisposed() || this.controlSocket !== controlSocket) {
				return;
			}
			this.callbacks.ensureVisible();
			this.controlSocket = null;
			this.pendingRestoreRequest = false;
			this.callbacks.onLastError("Terminal control connection closed. Close and reopen to reconnect.");
		};
	}

	markRestoreCompleted(): void {
		this.restoreCompleted = true;
		this.sendControl({ type: "restore_complete" });
		if (!this.pendingRestoreRequest) {
			return;
		}
		log.info(`slot ${this.slotId} replaying queued restore request after initial restore`);
		this.sendRestoreRequest();
	}

	closeAll(): void {
		if (this.ioSocket) {
			const socket = this.ioSocket;
			this.ioSocket = null;
			socket.close();
		}
		if (this.controlSocket) {
			const socket = this.controlSocket;
			this.controlSocket = null;
			socket.close();
		}
	}

	resetConnectionState(): void {
		this.connectionReady = false;
		this.restoreCompleted = false;
		this.pendingRestoreRequest = false;
		this.outputTextDecoder = new TextDecoder();
	}

	requestRestore(): boolean {
		const socketState = this.controlSocket?.readyState;
		if (!this.controlSocket || socketState !== WebSocket.OPEN) {
			log.warn(`slot ${this.slotId} requestRestore skipped — control socket not open`, {
				hasSocket: this.controlSocket !== null,
				readyState: socketState,
			});
			return false;
		}
		if (!this.restoreCompleted) {
			this.pendingRestoreRequest = true;
			log.info(`slot ${this.slotId} queued restore request until initial restore completes`);
			return true;
		}
		this.sendRestoreRequest();
		return true;
	}

	private sendRestoreRequest(): void {
		log.info(`slot ${this.slotId} requesting restore from server`);
		this.pendingRestoreRequest = false;
		this.restoreCompleted = false;
		this.sendControl({ type: "request_restore" });
	}
}
