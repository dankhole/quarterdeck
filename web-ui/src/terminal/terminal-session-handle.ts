import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskSessionSummary,
	RuntimeTerminalWsClientMessage,
	RuntimeTerminalWsServerMessage,
} from "@/runtime/types";
import { SlotSocketManager } from "@/terminal/slot-socket-manager";
import { generateTerminalClientId } from "@/terminal/terminal-socket-utils";
import { createClientLogger } from "@/utils/client-logger";

const log = createClientLogger("terminal-session-handle");
const CONNECTION_READY_FALLBACK_MS = 1500;

// [perf-investigation] Count reconnect() calls across all slots to see if the
// session_instance_changed path from terminal-attachment-controller:131 is
// firing repeatedly on an idle agent. Pairs with the console.trace in that
// file. Uses console.info instead of client logging/warn capture. Remove if
// investigation shows reconnect is not the cause.
const RECONNECT_REPORT_INTERVAL_MS = 5000;
let reconnectCallTotal = 0;
let reconnectCallWindow = 0;
let reconnectWindowStart = performance.now();

function roundPerf(value: number): number {
	return Math.round(value * 10) / 10;
}

function reportReconnectRate(slotId: number, reason: "session_instance_changed", taskId: string): void {
	reconnectCallTotal += 1;
	reconnectCallWindow += 1;
	const now = performance.now();
	const elapsed = now - reconnectWindowStart;
	if (reconnectCallTotal !== 1 && elapsed < RECONNECT_REPORT_INTERVAL_MS) {
		return;
	}
	console.info(`[perf-investigation] slot ${slotId} terminal reconnect rate`, {
		reason,
		taskId,
		totalReconnects: reconnectCallTotal,
		reconnectsInWindow: reconnectCallWindow,
		windowMs: Math.round(elapsed),
		ratePerSec: elapsed > 0 ? roundPerf((reconnectCallWindow / elapsed) * 1000) : reconnectCallWindow,
	});
	reconnectCallWindow = 0;
	reconnectWindowStart = now;
}

export interface PersistentTerminalSubscriber {
	onConnectionReady?: (taskId: string) => void;
	onLastError?: (message: string | null) => void;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onOutputText?: (text: string) => void;
	onExit?: (taskId: string, exitCode: number | null) => void;
}

interface TerminalSessionHandleCallbacks {
	enqueueWrite: (data: string | Uint8Array, options?: { ackBytes?: number; notifyText?: string | null }) => void;
	applyRestore: (snapshot: string, cols: number | null | undefined, rows: number | null | undefined) => Promise<void>;
	onSummaryStateChange: (
		summary: RuntimeTaskSessionSummary,
		previousSummary: RuntimeTaskSessionSummary | null,
	) => void;
	onExit: (code: number | null) => void;
	ensureVisible: () => void;
	invalidateResize: () => void;
	requestResize: () => void;
	getVisibleContainer: () => HTMLDivElement | null;
	getStageContainer: () => HTMLDivElement | null;
	isDisposed: () => boolean;
}

export class TerminalSessionHandle {
	private readonly subscribers = new Set<PersistentTerminalSubscriber>();
	private readonly clientId = generateTerminalClientId();
	private readonly sockets: SlotSocketManager;
	private taskId: string | null = null;
	private projectId: string | null = null;
	private latestSummary: RuntimeTaskSessionSummary | null = null;
	private lastError: string | null = null;
	private onceConnectionReadyCallback: (() => void) | null = null;
	private connectTimestamp: number | null = null;
	private restoreRequestTimestamp: number | null = null;
	private connectionReadyFallbackTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly slotId: number,
		private readonly callbacks: TerminalSessionHandleCallbacks,
	) {
		this.sockets = new SlotSocketManager(this.slotId, this.clientId, {
			enqueueWrite: (data, options) => {
				this.callbacks.enqueueWrite(data, options);
			},
			onRestore: async (snapshot, cols, rows) => {
				await this.handleRestore(snapshot, cols, rows);
			},
			onState: (payload) => {
				this.handleState(payload);
			},
			onExit: (code) => {
				this.handleExit(code);
			},
			onError: (message) => {
				this.callbacks.enqueueWrite(`\r\n[quarterdeck] ${message}\r\n`);
			},
			onIoOpen: () => {
				if (!this.sockets.connectionReady) {
					this.scheduleConnectionReadyFallback();
				}
			},
			onConnectionReady: () => {
				this.notifyConnectionReady();
			},
			onLastError: (message) => {
				this.lastError = message;
				this.notifyLastError();
			},
			ensureVisible: () => {
				this.callbacks.ensureVisible();
			},
			invalidateResize: () => {
				this.callbacks.invalidateResize();
			},
			requestResize: () => {
				this.callbacks.requestResize();
			},
			getVisibleContainer: () => this.callbacks.getVisibleContainer(),
			getStageContainer: () => this.callbacks.getStageContainer(),
			isDisposed: () => this.callbacks.isDisposed(),
		});
	}

	get connectedTaskId(): string | null {
		return this.taskId;
	}

	get connectedProjectId(): string | null {
		return this.projectId;
	}

	get sessionState(): string | null {
		return this.latestSummary?.state ?? null;
	}

	get sessionAgentId(): RuntimeTaskSessionSummary["agentId"] | null {
		return this.latestSummary?.agentId ?? null;
	}

	get hasIoSocket(): boolean {
		return this.sockets.hasIoSocket;
	}

	get hasControlSocket(): boolean {
		return this.sockets.hasControlSocket;
	}

	get isIoOpen(): boolean {
		return this.sockets.isIoOpen;
	}

	get restoreCompleted(): boolean {
		return this.sockets.restoreCompleted;
	}

	ensureConnected(): void {
		if (this.callbacks.isDisposed() || !this.taskId || !this.projectId) {
			return;
		}
		this.sockets.connectIo(this.taskId, this.projectId);
		this.sockets.connectControl(this.taskId, this.projectId);
		if (!this.sockets.connectionReady) {
			this.scheduleConnectionReadyFallback();
		}
	}

	reconnect(reason: "session_instance_changed"): void {
		if (this.callbacks.isDisposed() || !this.taskId || !this.projectId) {
			return;
		}
		reportReconnectRate(this.slotId, reason, this.taskId);
		// Session-instance changes can leave a reused pooled slot with a control
		// socket that is open but restoreCompleted=false. Closing both sockets is
		// more reliable than requesting another restore on that stale control
		// channel.
		log.debug(`slot ${this.slotId} reconnecting terminal sockets`, {
			taskId: this.taskId,
			projectId: this.projectId,
			reason,
			hadIoSocket: this.sockets.hasIoSocket,
			hadControlSocket: this.sockets.hasControlSocket,
			wasIoOpen: this.sockets.isIoOpen,
			restoreCompleted: this.sockets.restoreCompleted,
		});
		this.clearConnectionReadyFallback();
		this.sockets.closeAll();
		this.sockets.resetConnectionState();
		this.connectTimestamp = performance.now();
		this.restoreRequestTimestamp = null;
		this.sockets.connectIo(this.taskId, this.projectId);
		this.sockets.connectControl(this.taskId, this.projectId);
		this.scheduleConnectionReadyFallback();
	}

	connectToTask(taskId: string, projectId: string): void {
		if (this.callbacks.isDisposed()) {
			return;
		}
		if (this.taskId === taskId && this.projectId === projectId) {
			this.ensureConnected();
			return;
		}
		if (this.taskId) {
			this.sockets.closeAll();
		}
		this.taskId = taskId;
		this.projectId = projectId;
		this.connectTimestamp = performance.now();
		this.sockets.connectIo(taskId, projectId);
		this.sockets.connectControl(taskId, projectId);
		this.scheduleConnectionReadyFallback();
	}

	disconnectFromTask(): string | null {
		if (!this.taskId) {
			return null;
		}
		const previousTaskId = this.taskId;
		this.sockets.closeAll();
		this.sockets.resetConnectionState();
		this.latestSummary = null;
		this.lastError = null;
		this.restoreRequestTimestamp = null;
		this.clearConnectionReadyFallback();
		this.taskId = null;
		this.projectId = null;
		this.subscribers.clear();
		this.onceConnectionReadyCallback = null;
		return previousTaskId;
	}

	onceConnectionReady(callback: () => void): void {
		this.onceConnectionReadyCallback = callback;
	}

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber.onLastError?.(this.lastError);
		if (this.latestSummary) {
			subscriber.onSummary?.(this.latestSummary);
		}
		if (this.sockets.connectionReady && this.taskId) {
			subscriber.onConnectionReady?.(this.taskId);
		}
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	sendIo(data: string | Uint8Array): boolean {
		return this.sockets.sendIo(data);
	}

	sendControl(message: RuntimeTerminalWsClientMessage): boolean {
		return this.sockets.sendControl(message);
	}

	requestRestore(): void {
		if (this.callbacks.isDisposed()) {
			log.warn(`slot ${this.slotId} requestRestore skipped — terminal disposed`);
			return;
		}
		this.restoreRequestTimestamp = performance.now();
		this.sockets.requestRestore();
	}

	async stop(): Promise<void> {
		if (!this.connectedTaskId || !this.connectedProjectId) {
			return;
		}
		this.sendControl({ type: "stop" });
		const trpcClient = getRuntimeTrpcClient(this.connectedProjectId);
		await trpcClient.runtime.stopTaskSession.mutate({ taskId: this.connectedTaskId });
	}

	dispose(): void {
		this.sockets.closeAll();
		this.clearConnectionReadyFallback();
		this.subscribers.clear();
		this.onceConnectionReadyCallback = null;
	}

	private clearConnectionReadyFallback(): void {
		if (this.connectionReadyFallbackTimer === null) {
			return;
		}
		clearTimeout(this.connectionReadyFallbackTimer);
		this.connectionReadyFallbackTimer = null;
	}

	private scheduleConnectionReadyFallback(): void {
		this.clearConnectionReadyFallback();
		this.connectionReadyFallbackTimer = setTimeout(() => {
			this.connectionReadyFallbackTimer = null;
			if (this.callbacks.isDisposed() || !this.taskId || this.sockets.connectionReady) {
				return;
			}
			if (!this.sockets.isIoOpen) {
				log.warn(`slot ${this.slotId} terminal still waiting for IO socket before becoming interactive`, {
					taskId: this.taskId,
					projectId: this.projectId,
					hasControlSocket: this.sockets.hasControlSocket,
				});
				return;
			}
			log.warn(`slot ${this.slotId} terminal restore readiness fallback`, {
				taskId: this.taskId,
				projectId: this.projectId,
				hasControlSocket: this.sockets.hasControlSocket,
			});
			// IO is open, so input can work even if the restore/control handshake
			// is late. Reveal the terminal instead of blocking the user behind a
			// loading overlay; do not request another restore here because a stale
			// empty snapshot can erase live Codex output.
			this.callbacks.ensureVisible();
			this.notifyConnectionReady();
		}, CONNECTION_READY_FALLBACK_MS);
	}

	private async handleRestore(
		snapshot: string,
		cols: number | null | undefined,
		rows: number | null | undefined,
	): Promise<void> {
		const startTime = performance.now();
		await this.callbacks.applyRestore(snapshot, cols, rows);
		log.debug(`[perf] slot ${this.slotId} restore applied`, {
			elapsedMs: (performance.now() - startTime).toFixed(1),
			snapshotLength: snapshot.length,
		});
		if (this.restoreRequestTimestamp !== null) {
			log.debug(`[perf] slot ${this.slotId} restore round-trip`, {
				elapsedMs: (performance.now() - this.restoreRequestTimestamp).toFixed(1),
			});
			this.restoreRequestTimestamp = null;
		}
	}

	private handleState(payload: RuntimeTerminalWsServerMessage & { type: "state" }): void {
		const previousSummary = this.latestSummary;
		this.latestSummary = payload.summary;
		this.callbacks.onSummaryStateChange(payload.summary, previousSummary);
		for (const subscriber of this.subscribers) {
			subscriber.onSummary?.(payload.summary);
		}
	}

	private handleExit(code: number | null): void {
		this.callbacks.onExit(code);
		if (!this.taskId) {
			return;
		}
		if (this.latestSummary?.agentId != null) {
			return;
		}
		const taskId = this.taskId;
		for (const subscriber of this.subscribers) {
			subscriber.onExit?.(taskId, code);
		}
	}

	private notifyLastError(): void {
		for (const subscriber of this.subscribers) {
			subscriber.onLastError?.(this.lastError);
		}
	}

	publishOutputText(text: string): void {
		for (const subscriber of this.subscribers) {
			subscriber.onOutputText?.(text);
		}
	}

	private notifyConnectionReady(): void {
		if (!this.taskId) {
			return;
		}
		this.clearConnectionReadyFallback();
		this.sockets.connectionReady = true;
		if (this.connectTimestamp !== null) {
			log.debug(`[perf] slot ${this.slotId} connect-to-ready`, {
				elapsedMs: (performance.now() - this.connectTimestamp).toFixed(1),
			});
			this.connectTimestamp = null;
		}
		const taskId = this.taskId;
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionReady?.(taskId);
		}
		if (this.onceConnectionReadyCallback) {
			const callback = this.onceConnectionReadyCallback;
			this.onceConnectionReadyCallback = null;
			callback();
		}
	}

	notifyInteractiveShown(showTimestamp: number | null): void {
		if (showTimestamp === null) {
			return;
		}
		log.debug(`[perf] slot ${this.slotId} show-to-interactive`, {
			elapsedMs: (performance.now() - showTimestamp).toFixed(1),
		});
	}

	notifyConnectionReadyAfterRestore(showTimestamp: number | null): void {
		this.notifyInteractiveShown(showTimestamp);
		if (!this.sockets.connectionReady) {
			this.notifyConnectionReady();
		}
	}
}
