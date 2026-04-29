import type { RuntimeTerminalWsClientMessage, RuntimeTerminalWsServerMessage } from "@/runtime/types";
import {
	decodeTerminalSocketChunk,
	getTerminalSocketChunkByteLength,
	getTerminalSocketWriteData,
	getTerminalWebSocketUrl,
} from "@/terminal/terminal-socket-utils";
import type { TerminalWriteOptions } from "@/terminal/terminal-write-options";
import { createClientLogger } from "@/utils/client-logger";

const log = createClientLogger("slot-socket");
const RESTORE_STALL_WARNING_MS = 10_000;

interface SlotSocketCallbacks {
	enqueueWrite: (data: string | Uint8Array, options?: TerminalWriteOptions) => void;
	onRestore: (snapshot: string, cols: number | null | undefined, rows: number | null | undefined) => Promise<void>;
	onState: (payload: RuntimeTerminalWsServerMessage & { type: "state" }) => void;
	onExit: (code: number | null) => void;
	onError: (message: string) => void;
	onIoOpen: () => void;
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
	private restoreInProgress = false;
	private restoreStallWarningTimer: ReturnType<typeof setTimeout> | null = null;
	private restoreStartedAt: number | null = null;
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
				batch: true,
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
			this.callbacks.onIoOpen();
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
			if (this.restoreInProgress) {
				log.warn(`slot ${this.slotId} IO socket closed while restore was pending`);
			}
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
		this.beginRestoreCycle("initial_connect");
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
				this.beginRestoreCycle("restore_payload");
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
						log.warn(`slot ${this.slotId} restore failed while applying snapshot`, {
							snapshotLength: payload.snapshot.length,
						});
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
			if (this.restoreInProgress || this.pendingRestoreRequest) {
				log.warn(`slot ${this.slotId} control socket closed during restore`, {
					restoreInProgress: this.restoreInProgress,
					pendingRestoreRequest: this.pendingRestoreRequest,
				});
			}
			this.clearRestoreWatchdog();
			this.restoreInProgress = false;
			this.pendingRestoreRequest = false;
			this.callbacks.onLastError("Terminal control connection closed. Close and reopen to reconnect.");
		};
	}

	markRestoreCompleted(): void {
		this.restoreInProgress = false;
		this.restoreCompleted = true;
		this.clearRestoreWatchdog();
		this.sendControl({ type: "restore_complete" });
		if (!this.pendingRestoreRequest) {
			return;
		}
		// A request_restore can arrive while the initial restore is still being
		// applied. Replay it only after restore_complete so the server does not
		// interleave two snapshots with live output. If this completion never
		// arrives, TerminalSessionHandle.reconnect(...) drops the stale socket on
		// the next session-instance change.
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
		this.pendingRestoreRequest = false;
		this.restoreInProgress = false;
		this.clearRestoreWatchdog();
	}

	resetConnectionState(): void {
		this.connectionReady = false;
		this.restoreCompleted = false;
		this.pendingRestoreRequest = false;
		this.restoreInProgress = false;
		this.clearRestoreWatchdog();
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
		this.beginRestoreCycle("request_restore");
		this.sendControl({ type: "request_restore" });
	}

	private beginRestoreCycle(reason: string): void {
		if (!this.restoreInProgress) {
			this.restoreStartedAt = performance.now();
		}
		this.restoreInProgress = true;
		this.restoreCompleted = false;
		this.scheduleRestoreWatchdog(reason);
	}

	private scheduleRestoreWatchdog(reason: string): void {
		this.clearRestoreWatchdog();
		this.restoreStallWarningTimer = setTimeout(() => {
			this.restoreStallWarningTimer = null;
			if (!this.restoreInProgress) {
				return;
			}
			const elapsedMs =
				this.restoreStartedAt === null ? null : Math.round((performance.now() - this.restoreStartedAt) * 10) / 10;
			log.warn(`slot ${this.slotId} restore still pending after ${RESTORE_STALL_WARNING_MS}ms`, {
				reason,
				elapsedMs,
				hasControlSocket: this.controlSocket !== null,
				hasIoSocket: this.ioSocket !== null,
				pendingRestoreRequest: this.pendingRestoreRequest,
			});
		}, RESTORE_STALL_WARNING_MS);
	}

	private clearRestoreWatchdog(): void {
		if (this.restoreStallWarningTimer === null) {
			return;
		}
		clearTimeout(this.restoreStallWarningTimer);
		this.restoreStallWarningTimer = null;
	}
}
