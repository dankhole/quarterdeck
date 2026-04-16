import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskSessionSummary,
	RuntimeTerminalWsClientMessage,
	RuntimeTerminalWsServerMessage,
} from "@/runtime/types";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import {
	createQuarterdeckTerminalOptions,
	TERMINAL_FONT_SIZE,
	TERMINAL_PRIMARY_FONT,
} from "@/terminal/terminal-options";
import {
	appendTerminalHeuristicText,
	hasInterruptAcknowledgement,
	hasLikelyShellPrompt,
} from "@/terminal/terminal-prompt-heuristics";
import {
	decodeTerminalSocketChunk,
	generateTerminalClientId,
	getTerminalSocketChunkByteLength,
	getTerminalSocketWriteData,
	getTerminalWebSocketUrl,
	isCopyShortcut,
} from "@/terminal/terminal-socket-utils";
import { createClientLogger } from "@/utils/client-logger";
import { isMacPlatform } from "@/utils/platform";

const log = createClientLogger("terminal-slot");

const SHIFT_ENTER_SEQUENCE = "\n";
const RESIZE_DEBOUNCE_MS = 50;
const FONT_READY_TIMEOUT_MS = 3000;
const INTERRUPT_IDLE_SETTLE_MS = 250;
const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";
/** Scrollback buffer size shared by pool slots and dedicated terminals. Keep in sync with session-manager.ts server-side headless mirror. */
export const TERMINAL_SCROLLBACK = 3_000;

let currentTerminalFontWeight: number = CONFIG_DEFAULTS.terminalFontWeight;
let currentTerminalWebGLRenderer: boolean = CONFIG_DEFAULTS.terminalWebGLRenderer;

export interface PersistentTerminalAppearance {
	cursorColor: string;
	terminalBackgroundColor: string;
}

interface PersistentTerminalSubscriber {
	onConnectionReady?: (taskId: string) => void;
	onLastError?: (message: string | null) => void;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onOutputText?: (text: string) => void;
	onExit?: (taskId: string, exitCode: number | null) => void;
}

function getParkingRoot(): HTMLDivElement {
	const existingRoot = document.getElementById(PARKING_ROOT_ID);
	if (existingRoot instanceof HTMLDivElement) {
		return existingRoot;
	}
	const root = document.createElement("div");
	root.id = PARKING_ROOT_ID;
	root.setAttribute("aria-hidden", "true");
	Object.assign(root.style, {
		position: "fixed",
		left: "-10000px",
		top: "-10000px",
		width: "1px",
		height: "1px",
		overflow: "hidden",
		opacity: "0",
		pointerEvents: "none",
	});
	document.body.appendChild(root);
	return root;
}

/** Update the global font weight state used when constructing new terminals. */
export function updateGlobalTerminalFontWeight(weight: number): void {
	currentTerminalFontWeight = weight;
}

/** Update the global WebGL renderer state used when constructing new terminals. */
export function updateGlobalTerminalWebGLRenderer(enabled: boolean): void {
	currentTerminalWebGLRenderer = enabled;
}

export class TerminalSlot {
	readonly slotId: number;
	private readonly terminal: Terminal;
	private readonly fitAddon = new FitAddon();
	private readonly hostElement: HTMLDivElement;
	private readonly subscribers = new Set<PersistentTerminalSubscriber>();
	private readonly parkingRoot: HTMLDivElement;
	private readonly unicode11Addon = new Unicode11Addon();
	// This identifies one browser viewer, not the PTY session itself.
	// The server uses it to keep per-tab restore and socket state while all tabs
	// still share the same taskId backed PTY.
	private readonly clientId = generateTerminalClientId();
	private appearance: PersistentTerminalAppearance;
	private taskId: string | null = null;
	private workspaceId: string | null = null;
	private latestSummary: RuntimeTaskSessionSummary | null = null;
	private lastError: string | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private webglAddon: WebglAddon | null = null;
	private dprMediaQuery: MediaQueryList | null = null;
	private dprChangeHandler: (() => void) | null = null;
	private visibleContainer: HTMLDivElement | null = null;
	/** The container the hostElement is physically in the DOM (set by pool or dedicated caller). */
	private stageContainer: HTMLDivElement | null = null;
	private ioSocket: WebSocket | null = null;
	private controlSocket: WebSocket | null = null;
	private connectionReady = false;
	private restoreCompleted = false;
	/** Deferred focus — set by show() when autoFocus is requested before restore completes. */
	private pendingAutoFocus = false;
	private outputTextDecoder = new TextDecoder();
	private terminalWriteQueue: Promise<void> = Promise.resolve();
	/** Bumped on any lifecycle event where the server may not know our dimensions. */
	private resizeEpoch = 0;
	/** The epoch that was current when we last successfully sent a resize message. */
	private lastSatisfiedResizeEpoch = -1;
	/** Cols/rows we last sent — for within-epoch dedup when dimensions change. */
	private lastSentCols = 0;
	private lastSentRows = 0;
	private disposed = false;
	/** One-shot: scroll to bottom after the first ResizeObserver-driven fit() reflow in show(). */
	private pendingScrollToBottom = false;
	/** One-shot callback fired when notifyConnectionReady() runs, then cleared. */
	private onceConnectionReadyCallback: (() => void) | null = null;
	private visibilityChangeHandler: (() => void) | null = null;

	constructor(slotId: number, appearance: PersistentTerminalAppearance) {
		this.slotId = slotId;
		this.appearance = appearance;
		this.parkingRoot = getParkingRoot();
		this.hostElement = document.createElement("div");
		Object.assign(this.hostElement.style, {
			width: "100%",
			height: "100%",
			position: "absolute",
			inset: "0",
			visibility: "hidden",
		});
		this.parkingRoot.appendChild(this.hostElement);
		const initialGeometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);

		this.terminal = new Terminal({
			...createQuarterdeckTerminalOptions({
				cursorColor: this.appearance.cursorColor,
				fontWeight: currentTerminalFontWeight,
				isMacPlatform,
				scrollback: TERMINAL_SCROLLBACK,
				terminalBackgroundColor: this.appearance.terminalBackgroundColor,
			}),
			cols: initialGeometry.cols,
			rows: initialGeometry.rows,
		});
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(new ClipboardAddon());
		this.terminal.loadAddon(new WebLinksAddon());
		this.terminal.loadAddon(this.unicode11Addon);
		this.terminal.unicode.activeVersion = "11";
		this.terminal.onData((data) => {
			this.sendIoData(data);
		});
		this.terminal.onBinary((data) => {
			const bytes = new Uint8Array(data.length);
			for (let index = 0; index < data.length; index += 1) {
				bytes[index] = data.charCodeAt(index) & 0xff;
			}
			this.sendIoData(bytes);
		});
		this.terminal.attachCustomKeyEventHandler((event) => {
			if (event.key === "Enter" && event.shiftKey) {
				if (event.type === "keydown") {
					this.terminal.input(SHIFT_ENTER_SEQUENCE);
				}
				return false;
			}
			if (isCopyShortcut(event) && this.terminal.hasSelection()) {
				void navigator.clipboard.writeText(this.terminal.getSelection()).catch(() => {
					// Ignore clipboard failures.
				});
				return false;
			}
			return true;
		});

		this.openTerminalWhenFontsReady();
		// Repaint when the browser tab returns to foreground — GPU may have evicted
		// textures or skipped frames while backgrounded. Also reconnect dead sockets
		// (e.g. after the computer wakes from sleep).
		this.visibilityChangeHandler = () => {
			if (document.visibilityState === "visible" && this.visibleContainer && !this.disposed) {
				log.debug(`slot ${this.slotId} tab-return refresh`, { task: this.taskId });
				this.terminal.refresh(0, this.terminal.rows - 1);
				// Reconnect sockets that died during sleep/background.
				if (this.taskId && this.workspaceId && (!this.ioSocket || !this.controlSocket)) {
					log.info(`slot ${this.slotId} tab-return reconnecting dead sockets`, { task: this.taskId });
					this.connectIo();
					this.connectControl();
				}
			}
		};
		document.addEventListener("visibilitychange", this.visibilityChangeHandler);
		// No ensureConnected() — the pool controls IO state via connectToTask().
	}

	/** The task this slot is currently connected to, or null if idle. */
	get connectedTaskId(): string | null {
		return this.taskId;
	}

	/** The workspace this slot is currently connected to, or null if idle. */
	get connectedWorkspaceId(): string | null {
		return this.workspaceId;
	}

	/**
	 * Re-open IO + control sockets if they have been closed (e.g. after sleep).
	 * No-op if sockets are already open.
	 */
	ensureConnected(): void {
		if (this.disposed || !this.taskId || !this.workspaceId) return;
		this.connectIo();
		this.connectControl();
	}

	/**
	 * Connect this slot to a task. Opens IO + control sockets.
	 * No-op if already connected to the same task.
	 */
	connectToTask(taskId: string, workspaceId: string): void {
		if (this.disposed) {
			return;
		}
		if (this.taskId === taskId && this.workspaceId === workspaceId) {
			return;
		}
		// If already connected to a different task, close existing sockets first
		// to prevent leaks. The pool normally calls disconnectFromTask before reuse,
		// but this guard makes the method self-contained.
		if (this.taskId) {
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
		this.taskId = taskId;
		this.workspaceId = workspaceId;
		this.connectIo();
		this.connectControl();
	}

	/**
	 * Disconnect from the current task. Closes sockets, drains write queue,
	 * resets the terminal buffer, and clears all task-specific state.
	 * Does NOT touch xterm, DOM, or WebGL.
	 */
	async disconnectFromTask(): Promise<void> {
		if (!this.taskId) {
			return;
		}
		const previousTaskId = this.taskId;

		// Close sockets first (stop new data)
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

		// Clear ALL task-specific state synchronously before any await.
		// The pool may reuse this slot immediately via connectToTask() — if state
		// mutation happened after the await, the async tail would clobber the new
		// task's connection (taskId, subscribers, buffer).
		this.connectionReady = false;
		this.restoreCompleted = false;
		this.pendingAutoFocus = false;
		this.latestSummary = null;
		this.lastError = null;
		this.outputTextDecoder = new TextDecoder();
		clearTerminalGeometry(previousTaskId);
		this.taskId = null;
		this.workspaceId = null;
		this.subscribers.clear();
		this.onceConnectionReadyCallback = null;

		// Drain the write queue, then reset the buffer. These are safe after
		// state is cleared — connectToTask opens new sockets and the server
		// sends a fresh restore snapshot that overwrites the buffer.
		await this.terminalWriteQueue.catch(() => undefined);
		// Guard: if a new task connected while we were awaiting, don't reset
		// its buffer.
		if (!this.taskId) {
			this.terminal.reset();
		}
	}

	/**
	 * Register a one-shot callback that fires when notifyConnectionReady() runs.
	 * Cleared by disconnectFromTask().
	 */
	onceConnectionReady(callback: () => void): void {
		this.onceConnectionReadyCallback = callback;
	}

	private openTerminalWhenFontsReady(): void {
		const fontCheckString = `${TERMINAL_FONT_SIZE}px '${TERMINAL_PRIMARY_FONT}'`;

		const openAndAttachWebgl = () => {
			if (this.disposed) {
				return;
			}
			this.terminal.open(this.hostElement);
			this.attachWebglAddon();
			if (this.stageContainer ?? this.visibleContainer) {
				this.fitAddon.fit();
			}
		};

		const refitAfterFontsReady = () => {
			void document.fonts.ready.then(() => {
				if (!this.disposed && (this.stageContainer ?? this.visibleContainer)) {
					this.fitAddon.fit();
				}
			});
		};

		if (document.fonts.check(fontCheckString)) {
			openAndAttachWebgl();
		} else {
			const timeout = new Promise<void>((r) => setTimeout(r, FONT_READY_TIMEOUT_MS));
			void Promise.race([document.fonts.ready, timeout]).then(openAndAttachWebgl);
			refitAfterFontsReady();
		}
	}

	private attachWebglAddon(): void {
		if (!currentTerminalWebGLRenderer) {
			return;
		}
		try {
			const webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				webglAddon.dispose();
				this.webglAddon = null;
			});
			this.terminal.loadAddon(webglAddon);
			this.webglAddon = webglAddon;
		} catch {
			// Fall back to the default renderer when WebGL is unavailable.
		}
	}

	private notifyExit(code: number | null): void {
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

	private notifySummary(summary: RuntimeTaskSessionSummary): void {
		this.latestSummary = summary;
		for (const subscriber of this.subscribers) {
			subscriber.onSummary?.(summary);
		}
	}

	private notifyOutputText(text: string): void {
		for (const subscriber of this.subscribers) {
			subscriber.onOutputText?.(text);
		}
	}

	private notifyConnectionReady(): void {
		if (!this.taskId) {
			return;
		}
		this.connectionReady = true;
		const taskId = this.taskId;
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionReady?.(taskId);
		}
		if (this.onceConnectionReadyCallback) {
			const cb = this.onceConnectionReadyCallback;
			this.onceConnectionReadyCallback = null;
			cb();
		}
	}

	/**
	 * Send a message on the control WebSocket. Returns true if the message was
	 * actually sent, false if the socket was missing or not open. Callers that
	 * update dedup state (e.g. requestResize) must check the return value and
	 * avoid marking the message as "sent" when it was silently dropped.
	 */
	private sendControlMessage(message: RuntimeTerminalWsClientMessage): boolean {
		if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.controlSocket.send(JSON.stringify(message));
		return true;
	}

	private sendIoData(data: string | Uint8Array): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.ioSocket.send(data);
		return true;
	}

	private enqueueTerminalWrite(
		data: string | Uint8Array,
		options: {
			ackBytes?: number;
			notifyText?: string | null;
		} = {},
	): Promise<void> {
		const ackBytes = options.ackBytes ?? 0;
		const notifyText = options.notifyText ?? null;
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(
				async () =>
					await new Promise<void>((resolve) => {
						if (this.disposed) {
							resolve();
							return;
						}
						this.terminal.write(data, () => {
							if (notifyText) {
								this.notifyOutputText(notifyText);
							}
							if (ackBytes > 0) {
								this.sendControlMessage({
									type: "output_ack",
									bytes: ackBytes,
								});
							}
							resolve();
						});
					}),
			);
		return this.terminalWriteQueue;
	}

	private async applyRestore(
		snapshot: string,
		cols: number | null | undefined,
		rows: number | null | undefined,
	): Promise<void> {
		// Server connection is fresh/reconnected and doesn't know our dimensions.
		this.invalidateResize();
		await this.terminalWriteQueue.catch(() => undefined);
		this.terminal.reset();
		if (cols && rows && (this.terminal.cols !== cols || this.terminal.rows !== rows)) {
			this.terminal.resize(cols, rows);
		}
		if (!snapshot) {
			return;
		}
		await this.enqueueTerminalWrite(snapshot);
	}

	/**
	 * Mark the current resize state as stale. The next requestResize() will
	 * unconditionally send dimensions to the server, even if cols/rows
	 * haven't changed since the last send.
	 */
	private invalidateResize(): void {
		this.resizeEpoch += 1;
	}

	/** Reveal the host element if it was deferred during restore. */
	private ensureVisible(): void {
		if (this.visibleContainer) {
			this.hostElement.style.visibility = "visible";
		}
	}

	/**
	 * Invalidate and immediately re-send terminal dimensions with force flag.
	 * The server sends SIGWINCH even if dimensions haven't changed, ensuring
	 * TUI agents redraw after task switch.
	 */
	private forceResize(): void {
		this.invalidateResize();
		this.requestResize(true);
	}

	private requestResize(force?: boolean): void {
		if (!this.connectedTaskId) {
			return;
		}
		// Allow resize if staged (in real container) even when not visible.
		// This enables warmup to send correct dimensions before the slot is shown.
		const container = this.visibleContainer ?? this.stageContainer;
		if (!container) {
			return;
		}
		this.fitAddon.fit();
		const { cols, rows } = this.terminal;
		const epochSatisfied = this.lastSatisfiedResizeEpoch === this.resizeEpoch;
		if (epochSatisfied && cols === this.lastSentCols && rows === this.lastSentRows && !force) {
			return;
		}
		const bounds = container.getBoundingClientRect();
		const pixelWidth = Math.round(bounds.width);
		const pixelHeight = Math.round(bounds.height);
		reportTerminalGeometry(this.connectedTaskId, { cols, rows });
		// Only mark as sent if the message actually reached the socket.
		// Otherwise the dedup check above will suppress future attempts
		// with the same dimensions, leaving the PTY at stale sizes.
		const sent = this.sendControlMessage({
			type: "resize",
			cols,
			rows,
			pixelWidth: pixelWidth > 0 ? pixelWidth : undefined,
			pixelHeight: pixelHeight > 0 ? pixelHeight : undefined,
			force: force || undefined,
		});
		if (sent) {
			this.lastSentCols = cols;
			this.lastSentRows = rows;
			this.lastSatisfiedResizeEpoch = this.resizeEpoch;
		}
	}

	private listenForDprChange(): void {
		this.clearDprListener();
		const dpr = window.devicePixelRatio;
		const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
		const handler = () => {
			// DPR changed (monitor move, zoom, display settings) — the glyph
			// texture atlas is now stale. A plain requestResize() would send
			// correct dimensions but leave blurry text. repairRendererCanvas()
			// clears the atlas, repaints, and includes a force-resize.
			this.repairRendererCanvas("dpr-change");
			// Re-register for the next DPR change since the query matched against the old value.
			this.listenForDprChange();
		};
		mq.addEventListener("change", handler, { once: true });
		this.dprMediaQuery = mq;
		this.dprChangeHandler = handler;
	}

	private clearDprListener(): void {
		if (this.dprMediaQuery && this.dprChangeHandler) {
			this.dprMediaQuery.removeEventListener("change", this.dprChangeHandler);
		}
		this.dprMediaQuery = null;
		this.dprChangeHandler = null;
	}

	private connectIo(): void {
		if (this.ioSocket) {
			return;
		}
		if (!this.taskId || !this.workspaceId) {
			return;
		}
		const ioSocket = new WebSocket(getTerminalWebSocketUrl("io", this.taskId, this.workspaceId, this.clientId));
		ioSocket.binaryType = "arraybuffer";
		// No browser-side restoreCompleted gate needed here — the server buffers output
		// in pendingOutputChunks until restore_complete is acknowledged, so IO data only
		// arrives after the restore snapshot has been applied. See ws-server.ts onOutput.
		ioSocket.addEventListener("message", (event) => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			const writeData = getTerminalSocketWriteData(event.data);
			if (!writeData) {
				return;
			}
			const decoded = decodeTerminalSocketChunk(this.outputTextDecoder, event.data);
			void this.enqueueTerminalWrite(writeData, {
				ackBytes: getTerminalSocketChunkByteLength(event.data),
				notifyText: decoded || null,
			});
		});
		this.ioSocket = ioSocket;
		ioSocket.onopen = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.lastError = null;
			this.notifyLastError();
			// Socket reconnected — server may have lost our dimensions.
			this.invalidateResize();
			if (this.restoreCompleted && this.visibleContainer) {
				this.requestResize();
			}
			if (this.restoreCompleted) {
				this.notifyConnectionReady();
			}
		};
		ioSocket.onerror = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.ensureVisible();
			this.lastError = "Terminal stream failed.";
			this.notifyLastError();
		};
		ioSocket.onclose = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.ensureVisible();
			this.ioSocket = null;
			this.outputTextDecoder = new TextDecoder();
			this.connectionReady = false;
			this.restoreCompleted = false;
			this.lastError = "Terminal stream closed. Close and reopen to reconnect.";
			this.notifyLastError();
		};
	}

	private connectControl(): void {
		if (this.controlSocket) {
			return;
		}
		if (!this.taskId || !this.workspaceId) {
			return;
		}
		const controlSocket = new WebSocket(
			getTerminalWebSocketUrl("control", this.taskId, this.workspaceId, this.clientId),
		);
		this.controlSocket = controlSocket;
		controlSocket.onopen = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.lastError = null;
			this.notifyLastError();
		};
		controlSocket.onmessage = (event) => {
			let payload: RuntimeTerminalWsServerMessage;
			try {
				payload = JSON.parse(String(event.data)) as RuntimeTerminalWsServerMessage;
			} catch {
				// Ignore malformed control frames.
				return;
			}

			if (payload.type === "restore") {
				this.restoreCompleted = false;
				void this.applyRestore(payload.snapshot, payload.cols, payload.rows)
					.then(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.restoreCompleted = true;
						this.sendControlMessage({ type: "restore_complete" });
						this.terminal.scrollToBottom();
						// Reveal the terminal now that the buffer is populated and
						// the viewport is scrolled to the bottom. mount() defers
						// visibility when restoreCompleted is false to avoid the
						// full history visibly scrolling past during the write.
						this.ensureVisible();
						if (this.pendingAutoFocus) {
							this.pendingAutoFocus = false;
							this.terminal.focus();
						}
						if (this.ioSocket && (this.visibleContainer ?? this.stageContainer)) {
							this.requestResize();
						}
						if (this.ioSocket) {
							this.notifyConnectionReady();
						}
					})
					.catch(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						// Reveal on failure too so the terminal doesn't stay hidden.
						this.ensureVisible();
						if (this.pendingAutoFocus) {
							this.pendingAutoFocus = false;
							this.terminal.focus();
						}
						this.lastError = "Terminal restore failed.";
						this.notifyLastError();
					});
				return;
			}
			if (payload.type === "state") {
				const previousState = this.latestSummary?.state;
				this.notifySummary(payload.summary);
				// When a session newly starts, the server PTY may not have had our
				// terminal dimensions — the resize sent during the earlier restore
				// may have been silently dropped because the PTY didn't exist yet.
				// Only fire on the first transition INTO an active state (from null,
				// "starting", etc.), not on transitions between active states. Sending
				// a same-dimensions SIGWINCH while the agent is already running can
				// interrupt TUI layout mid-redraw (e.g. input prompt setup), causing
				// off-by-one artifacts.
				if (
					(this.visibleContainer ?? this.stageContainer) &&
					payload.summary.state !== previousState &&
					previousState !== "running" &&
					previousState !== "awaiting_review" &&
					(payload.summary.state === "running" || payload.summary.state === "awaiting_review")
				) {
					this.forceResize();
				}
				return;
			}
			if (payload.type === "exit") {
				const label = payload.code == null ? "session exited" : `session exited with code ${payload.code}`;
				void this.enqueueTerminalWrite(`\r\n[quarterdeck] ${label}\r\n`);
				this.notifyExit(payload.code);
				return;
			}
			if (payload.type === "error") {
				this.lastError = payload.message;
				this.notifyLastError();
				void this.enqueueTerminalWrite(`\r\n[quarterdeck] ${payload.message}\r\n`);
			}
		};
		controlSocket.onerror = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.ensureVisible();
			this.lastError = "Terminal control connection failed.";
			this.notifyLastError();
		};
		controlSocket.onclose = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.ensureVisible();
			this.controlSocket = null;
			this.lastError = "Terminal control connection closed. Close and reopen to reconnect.";
			this.notifyLastError();
		};
	}

	private updateAppearance(appearance: PersistentTerminalAppearance): void {
		this.appearance = appearance;
		this.terminal.options.theme = {
			...this.terminal.options.theme,
			...createQuarterdeckTerminalOptions({
				cursorColor: appearance.cursorColor,
				fontWeight: currentTerminalFontWeight,
				isMacPlatform,
				terminalBackgroundColor: appearance.terminalBackgroundColor,
			}).theme,
		};
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.updateAppearance(appearance);
	}

	setFontWeight(weight: number): void {
		this.terminal.options.fontWeight = weight;
	}

	setWebGLRenderer(enabled: boolean): void {
		if (enabled && !this.webglAddon) {
			this.attachWebglAddon();
		} else if (!enabled && this.webglAddon) {
			this.webglAddon.dispose();
			this.webglAddon = null;
		}
	}

	/**
	 * Read the current viewport content as an array of lines.
	 *
	 * Only reads the viewport (baseY → baseY + rows), not the scrollback
	 * history. TUI agents like Claude Code manage their own display within
	 * the viewport — the scrollback is either empty or contains stale content
	 * from session startup/restarts.
	 */
	readBufferLines(): string[] {
		const buffer = this.terminal.buffer.active;
		const baseY = buffer.baseY;
		const rows = this.terminal.rows;
		const result: string[] = [];
		for (let i = baseY; i < baseY + rows; i++) {
			const line = buffer.getLine(i);
			result.push(line ? line.translateToString(true) : "");
		}
		// Trim trailing empty lines — TUIs often don't fill the viewport.
		while (result.length > 0 && result[result.length - 1]!.trim() === "") {
			result.pop();
		}
		return result;
	}

	/**
	 * Move this slot's host element into a stage container. Called by the pool
	 * when a terminal container becomes available. After this call, fitAddon.fit()
	 * returns real dimensions even when the slot is hidden.
	 */
	attachToStageContainer(container: HTMLDivElement): void {
		if (this.disposed) return;
		if (this.stageContainer === container) return;
		const hadPrevious = this.stageContainer !== null;
		this.stageContainer = container;
		container.appendChild(this.hostElement);
		// Size to real container dimensions now that we're in the DOM properly.
		this.fitAddon.fit();
		log.debug(`slot ${this.slotId} staged`, {
			reparent: hadPrevious,
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		});
	}

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber.onLastError?.(this.lastError);
		if (this.latestSummary) {
			subscriber.onSummary?.(this.latestSummary);
		}
		if (this.connectionReady && this.taskId) {
			subscriber.onConnectionReady?.(this.taskId);
		}
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	show(appearance: PersistentTerminalAppearance, options: { autoFocus?: boolean; isVisible?: boolean }): void {
		if (this.disposed) {
			return;
		}
		this.updateAppearance(appearance);

		// Defer visibility when a restore snapshot is pending — the full history
		// would otherwise scroll past as xterm renders it incrementally. The
		// restore handler sets visibility = "visible" after scrollToBottom().
		const shouldReveal = this.restoreCompleted;
		log.debug(`slot ${this.slotId} show`, {
			reveal: shouldReveal,
			staged: this.stageContainer !== null,
			task: this.taskId,
		});

		// Cheap repaint from buffer — insurance against stale canvas frames
		// from browser tab backgrounding or GPU texture eviction.
		// No network, no SIGWINCH, no atlas clear.
		this.terminal.refresh(0, this.terminal.rows - 1);

		this.visibleContainer = this.stageContainer;

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
		}
		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeTimer !== null) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.requestResize();
				if (this.pendingScrollToBottom) {
					this.pendingScrollToBottom = false;
					this.terminal.scrollToBottom();
				}
			}, RESIZE_DEBOUNCE_MS);
		});
		if (this.stageContainer) {
			this.resizeObserver.observe(this.stageContainer);
		} else {
			log.warn(`slot ${this.slotId} show — no stageContainer, ResizeObserver not attached`);
		}
		this.listenForDprChange();
		if (options.isVisible !== false) {
			// Fit + scroll BEFORE revealing to avoid a visible frame at the
			// old scroll position. fit() may reflow the buffer when cols/rows
			// change, so scrollToBottom must come after it.
			this.requestResize();
			if (shouldReveal) {
				this.terminal.scrollToBottom();
				// Arm a one-shot for the first ResizeObserver callback in case
				// its fit() reflow undoes this scroll.
				this.pendingScrollToBottom = true;
			}
			if (options.autoFocus) {
				if (shouldReveal) {
					this.terminal.focus();
				} else {
					// Restore hasn't completed yet — the terminal is visibility:hidden
					// and browsers ignore focus on hidden elements. Defer until
					// restore completes and the terminal is revealed.
					this.pendingAutoFocus = true;
				}
			}
		}

		// Reveal only after fit + scroll are applied.
		if (shouldReveal) {
			this.hostElement.style.visibility = "visible";
		}
	}

	hide(): void {
		if (this.disposed && this.visibleContainer === null) {
			return;
		}
		log.debug(`slot ${this.slotId} hide`, { task: this.taskId });
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.resizeTimer !== null) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		this.clearDprListener();
		this.pendingAutoFocus = false;
		this.visibleContainer = null;
		if (this.connectedTaskId) {
			clearTerminalGeometry(this.connectedTaskId);
		}
		this.hostElement.style.visibility = "hidden";
	}

	get sessionState(): string | null {
		return this.latestSummary?.state ?? null;
	}

	writeText(text: string): void {
		if (this.disposed) {
			return;
		}
		void this.enqueueTerminalWrite(text);
	}

	focus(): void {
		this.terminal.focus();
	}

	input(text: string): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.terminal.input(text);
		return true;
	}

	paste(text: string): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.terminal.paste(text);
		return true;
	}

	clear(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.clear();
			});
	}

	reset(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.reset();
			});
	}

	/**
	 * Canvas repair sequence — the three steps that fix blurry/stale terminal
	 * rendering after a DPR change, monitor move, or DOM re-parent.
	 *
	 * xterm.js caches rendered glyphs in a texture atlas (both the WebGL and
	 * canvas 2D renderers). When the device pixel ratio changes or the canvas
	 * is moved in the DOM, the cached textures become stale but xterm doesn't
	 * automatically invalidate them. Three things need to happen:
	 *
	 *   1. **Dimension bounce** — resize(cols-1, rows) then forceResize() back
	 *      to the real size. fitAddon.fit() short-circuits when cols/rows
	 *      haven't changed, so the bounce forces it to actually call
	 *      terminal.resize() which recalculates the canvas pixel dimensions.
	 *
	 *   2. **clearTextureAtlas()** — discards the cached glyph textures so the
	 *      renderer rebuilds them at the current DPR. This is the step that
	 *      actually fixes blurriness. Without it, refresh() just re-composites
	 *      the same stale textures.
	 *
	 *   3. **refresh(0, rows-1)** — repaints every visible row from the buffer
	 *      using the newly rebuilt textures.
	 *
	 * All three steps must run together — skipping any one produces a subtle
	 * no-op where the button appears to "not do anything".
	 *
	 * Called from:
	 *   - DPR change handler — repairs after monitor move or browser zoom
	 *   - resetRenderer() — user-initiated "Reset terminal rendering" button
	 */
	private repairRendererCanvas(trigger: string): void {
		// No canvas to fix when the terminal is parked (not in any container).
		// The repair will run on the next show() instead.
		if (!this.stageContainer && !this.visibleContainer) {
			log.debug(`slot ${this.slotId} canvas repair skipped — not staged`, { trigger });
			return;
		}

		const t0 = performance.now();
		const prevCols = this.terminal.cols;
		const prevRows = this.terminal.rows;

		// Step 1: dimension bounce
		if (prevCols > 2) {
			this.terminal.resize(prevCols - 1, prevRows);
		}

		// Step 2: clear glyph texture cache
		this.terminal.clearTextureAtlas();

		// Step 3: repaint all rows
		this.terminal.refresh(0, prevRows - 1);

		// Restore real dimensions and send to server
		this.forceResize();

		const elapsed = (performance.now() - t0).toFixed(1);
		log.debug(`slot ${this.slotId} canvas repair`, {
			trigger,
			renderer: this.webglAddon ? "webgl" : "canvas-2d",
			dpr: window.devicePixelRatio,
			cols: prevCols,
			rows: prevRows,
			elapsedMs: elapsed,
		});
	}

	resetRenderer(): void {
		const hadWebgl = this.webglAddon !== null;
		if (this.webglAddon) {
			this.webglAddon.dispose();
			this.webglAddon = null;
		}
		this.attachWebglAddon();
		const newRenderer = this.webglAddon ? "webgl" : "canvas-2d";
		log.info(`slot ${this.slotId} renderer reset`, {
			previous: hadWebgl ? "webgl" : "none",
			current: newRenderer,
			dpr: window.devicePixelRatio,
		});
		this.repairRendererCanvas("resetRenderer");
	}

	/**
	 * Request a fresh restore snapshot from the server, replacing the entire
	 * local terminal buffer with the authoritative state from the headless
	 * mirror. Use this to repair terminals that have drifted into a weird
	 * visual state. The server pauses live output during the snapshot to
	 * prevent data loss.
	 */
	requestRestore(): void {
		if (this.disposed) {
			log.warn(`slot ${this.slotId} requestRestore skipped — terminal disposed`);
			return;
		}
		if (!this.restoreCompleted) {
			log.warn(`slot ${this.slotId} requestRestore skipped — initial restore not yet complete`);
			return;
		}
		const socketState = this.controlSocket?.readyState;
		if (!this.controlSocket || socketState !== WebSocket.OPEN) {
			log.warn(`slot ${this.slotId} requestRestore skipped — control socket not open`, {
				hasSocket: this.controlSocket !== null,
				readyState: socketState,
			});
			return;
		}
		log.info(`slot ${this.slotId} requesting restore from server`);
		this.sendControlMessage({ type: "request_restore" });
	}

	getBufferDebugInfo(): {
		activeBuffer: "ALTERNATE" | "NORMAL";
		normalLength: number;
		normalBaseY: number;
		normalScrollbackLines: number;
		alternateLength: number;
		viewportRows: number;
		scrollbackOption: number;
		sessionState: string | null;
	} {
		const buf = this.terminal.buffer;
		const isAlt = buf.active.type === "alternate";
		return {
			activeBuffer: isAlt ? "ALTERNATE" : "NORMAL",
			normalLength: buf.normal.length,
			normalBaseY: buf.normal.baseY,
			normalScrollbackLines: buf.normal.length - this.terminal.rows,
			alternateLength: buf.alternate.length,
			viewportRows: this.terminal.rows,
			scrollbackOption: this.terminal.options.scrollback ?? 0,
			sessionState: this.latestSummary?.state ?? null,
		};
	}

	waitForLikelyPrompt(timeoutMs: number): Promise<boolean> {
		if (timeoutMs <= 0) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			let buffer = "";
			let sawInterruptAcknowledgement = false;
			let settled = false;
			let idleTimer: number | null = null;

			const cleanup = (result: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutId);
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				unsubscribe();
				resolve(result);
			};

			const scheduleIdleCompletion = () => {
				if (!sawInterruptAcknowledgement) {
					return;
				}
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				idleTimer = window.setTimeout(() => {
					cleanup(true);
				}, INTERRUPT_IDLE_SETTLE_MS);
			};

			const unsubscribe = this.subscribe({
				onOutputText: (text) => {
					buffer = appendTerminalHeuristicText(buffer, text);
					if (hasLikelyShellPrompt(buffer)) {
						cleanup(true);
						return;
					}
					if (hasInterruptAcknowledgement(buffer)) {
						sawInterruptAcknowledgement = true;
					}
					scheduleIdleCompletion();
				},
			});

			const timeoutId = window.setTimeout(() => {
				cleanup(false);
			}, timeoutMs);
		});
	}

	async stop(): Promise<void> {
		if (!this.connectedTaskId || !this.connectedWorkspaceId) {
			return;
		}
		this.sendControlMessage({ type: "stop" });
		const trpcClient = getRuntimeTrpcClient(this.connectedWorkspaceId);
		await trpcClient.runtime.stopTaskSession.mutate({ taskId: this.connectedTaskId });
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		log.debug(`slot ${this.slotId} dispose`, { task: this.taskId });
		this.disposed = true;
		this.hide();
		this.stageContainer = null;
		if (this.visibilityChangeHandler) {
			document.removeEventListener("visibilitychange", this.visibilityChangeHandler);
			this.visibilityChangeHandler = null;
		}
		this.ioSocket?.close();
		this.controlSocket?.close();
		this.ioSocket = null;
		this.controlSocket = null;
		this.subscribers.clear();
		this.onceConnectionReadyCallback = null;
		this.terminal.dispose();
		this.hostElement.remove();
	}
}
