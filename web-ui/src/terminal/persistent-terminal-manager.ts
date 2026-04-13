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
import { isMacPlatform } from "@/utils/platform";

const SHIFT_ENTER_SEQUENCE = "\n";
const RESIZE_DEBOUNCE_MS = 50;
const FONT_READY_TIMEOUT_MS = 3000;
const INTERRUPT_IDLE_SETTLE_MS = 250;
const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";

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

interface MountPersistentTerminalOptions {
	autoFocus?: boolean;
	isVisible?: boolean;
}

export interface EnsurePersistentTerminalInput extends PersistentTerminalAppearance {
	taskId: string;
	workspaceId: string;
	scrollOnEraseInDisplay?: boolean;
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

export function buildKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

/** Update the global font weight state used when constructing new terminals. */
export function updateGlobalTerminalFontWeight(weight: number): void {
	currentTerminalFontWeight = weight;
}

/** Update the global WebGL renderer state used when constructing new terminals. */
export function updateGlobalTerminalWebGLRenderer(enabled: boolean): void {
	currentTerminalWebGLRenderer = enabled;
}

export class PersistentTerminal {
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
	private latestSummary: RuntimeTaskSessionSummary | null = null;
	private lastError: string | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private webglAddon: WebglAddon | null = null;
	private dprMediaQuery: MediaQueryList | null = null;
	private dprChangeHandler: (() => void) | null = null;
	private visibleContainer: HTMLDivElement | null = null;
	private ioSocket: WebSocket | null = null;
	private controlSocket: WebSocket | null = null;
	private connectionReady = false;
	private restoreCompleted = false;
	private outputTextDecoder = new TextDecoder();
	private terminalWriteQueue: Promise<void> = Promise.resolve();
	/** Bumped on any lifecycle event where the server may not know our dimensions. */
	private resizeEpoch = 0;
	/** The epoch that was current when we last successfully sent a resize message. */
	private lastSatisfiedResizeEpoch = -1;
	/** Cols/rows we last sent — for within-epoch dedup when dimensions change. */
	private lastSentCols = 0;
	private lastSentRows = 0;
	private deferredResizeRaf: number | null = null;
	private disposed = false;

	constructor(
		private readonly taskId: string,
		private readonly workspaceId: string,
		appearance: PersistentTerminalAppearance,
		scrollOnEraseInDisplay = true,
	) {
		this.appearance = appearance;
		this.parkingRoot = getParkingRoot();
		this.hostElement = document.createElement("div");
		Object.assign(this.hostElement.style, {
			width: "100%",
			height: "100%",
		});
		this.parkingRoot.appendChild(this.hostElement);
		const initialGeometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);

		this.terminal = new Terminal({
			...createQuarterdeckTerminalOptions({
				cursorColor: this.appearance.cursorColor,
				fontWeight: currentTerminalFontWeight,
				isMacPlatform,
				scrollOnEraseInDisplay,
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
		this.ensureConnected();
	}

	private openTerminalWhenFontsReady(): void {
		const fontCheckString = `${TERMINAL_FONT_SIZE}px '${TERMINAL_PRIMARY_FONT}'`;

		const openAndAttachWebgl = () => {
			if (this.disposed) {
				return;
			}
			this.terminal.open(this.hostElement);
			this.attachWebglAddon();
			if (this.visibleContainer) {
				this.fitAddon.fit();
			}
		};

		const refitAfterFontsReady = () => {
			void document.fonts.ready.then(() => {
				if (!this.disposed && this.visibleContainer) {
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
		if (this.latestSummary?.agentId != null) {
			return;
		}
		for (const subscriber of this.subscribers) {
			subscriber.onExit?.(this.taskId, code);
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
		this.connectionReady = true;
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionReady?.(this.taskId);
		}
	}

	private sendControlMessage(message: RuntimeTerminalWsClientMessage): void {
		if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
			return;
		}
		this.controlSocket.send(JSON.stringify(message));
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

	/**
	 * Invalidate and immediately re-send terminal dimensions.
	 * Convenience for lifecycle events that need both steps.
	 */
	private forceResize(): void {
		this.invalidateResize();
		this.requestResize();
	}

	private requestResize(): void {
		if (!this.visibleContainer) {
			return;
		}
		this.fitAddon.fit();
		const { cols, rows } = this.terminal;
		const epochSatisfied = this.lastSatisfiedResizeEpoch === this.resizeEpoch;
		if (epochSatisfied && cols === this.lastSentCols && rows === this.lastSentRows) {
			return;
		}
		this.lastSentCols = cols;
		this.lastSentRows = rows;
		this.lastSatisfiedResizeEpoch = this.resizeEpoch;
		const bounds = this.visibleContainer.getBoundingClientRect();
		const pixelWidth = Math.round(bounds.width);
		const pixelHeight = Math.round(bounds.height);
		reportTerminalGeometry(this.taskId, { cols, rows });
		this.sendControlMessage({
			type: "resize",
			cols,
			rows,
			pixelWidth: pixelWidth > 0 ? pixelWidth : undefined,
			pixelHeight: pixelHeight > 0 ? pixelHeight : undefined,
		});
	}

	private listenForDprChange(): void {
		this.clearDprListener();
		const dpr = window.devicePixelRatio;
		const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
		const handler = () => {
			this.requestResize();
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
			this.lastError = "Terminal stream failed.";
			this.notifyLastError();
		};
		ioSocket.onclose = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.ioSocket = null;
			this.outputTextDecoder = new TextDecoder();
			this.connectionReady = false;
			this.restoreCompleted = false;
			this.lastError = "Terminal stream closed. Close and reopen to reconnect.";
			this.notifyLastError();
		};
	}

	private connectControl(): void {
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
						if (this.ioSocket && this.visibleContainer) {
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
				if (
					this.visibleContainer &&
					payload.summary.state !== previousState &&
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
			this.lastError = "Terminal control connection failed.";
			this.notifyLastError();
		};
		controlSocket.onclose = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.controlSocket = null;
			this.lastError = "Terminal control connection closed. Close and reopen to reconnect.";
			this.notifyLastError();
		};
	}

	private ensureConnected(): void {
		if (this.disposed) {
			return;
		}
		if (!this.ioSocket) {
			this.connectIo();
		}
		if (!this.controlSocket) {
			this.connectControl();
		}
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

	setScrollOnEraseInDisplay(value: boolean): void {
		this.terminal.options.scrollOnEraseInDisplay = value;
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

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber.onLastError?.(this.lastError);
		if (this.latestSummary) {
			subscriber.onSummary?.(this.latestSummary);
		}
		if (this.connectionReady) {
			subscriber.onConnectionReady?.(this.taskId);
		}
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	mount(
		container: HTMLDivElement,
		appearance: PersistentTerminalAppearance,
		options: MountPersistentTerminalOptions,
	): void {
		if (this.disposed) {
			return;
		}
		this.ensureConnected();
		this.updateAppearance(appearance);
		if (this.visibleContainer !== container) {
			this.visibleContainer = container;
			container.appendChild(this.hostElement);
			// New container — previous resize may have targeted a different
			// (or parked) container, or been silently dropped.
			this.invalidateResize();
			// The host element was just moved from the parking root (or another
			// container). Schedule a deferred resize that:
			// 1. Forces the WebGL/canvas renderer to recalculate its canvas
			//    dimensions (fitAddon.fit() skips terminal.resize() when
			//    cols/rows match, leaving the canvas stale after a DOM move).
			// 2. Sends the intermediate cols-1 to the server so the PTY
			//    actually changes size → SIGWINCH → the agent redraws its
			//    TUI. Without this the server-side dimensions never change
			//    and artifacts from the previous render persist.
			if (this.deferredResizeRaf !== null) {
				cancelAnimationFrame(this.deferredResizeRaf);
			}
			this.deferredResizeRaf = requestAnimationFrame(() => {
				this.deferredResizeRaf = null;
				if (this.disposed || this.visibleContainer !== container) {
					return;
				}
				const { cols, rows } = this.terminal;
				if (cols > 2) {
					this.terminal.resize(cols - 1, rows);
					// Send the intermediate size to the server so the PTY
					// sees an actual dimension change and delivers SIGWINCH.
					this.sendControlMessage({ type: "resize", cols: cols - 1, rows });
				}
				this.forceResize();
			});
		}
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
			}, RESIZE_DEBOUNCE_MS);
		});
		this.resizeObserver.observe(container);
		this.listenForDprChange();
		if (options.isVisible !== false) {
			this.requestResize();
			if (options.autoFocus) {
				this.terminal.focus();
			}
		}
	}

	unmount(container: HTMLDivElement | null): void {
		if (this.disposed && this.visibleContainer === null) {
			return;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.resizeTimer !== null) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		if (this.deferredResizeRaf !== null) {
			cancelAnimationFrame(this.deferredResizeRaf);
			this.deferredResizeRaf = null;
		}
		this.clearDprListener();
		if (container && this.visibleContainer !== container) {
			return;
		}
		this.visibleContainer = null;
		clearTerminalGeometry(this.taskId);
		this.parkingRoot.appendChild(this.hostElement);
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

	resetRenderer(): void {
		const hadWebgl = this.webglAddon !== null;
		if (this.webglAddon) {
			this.webglAddon.dispose();
			this.webglAddon = null;
		}
		this.attachWebglAddon();
		// Force the (re)created renderer to recalculate canvas dimensions and
		// repaint. Without this the new addon initialises at stale dimensions
		// and the reset appears to do nothing.
		this.terminal.refresh(0, this.terminal.rows - 1);
		if (this.visibleContainer) {
			this.forceResize();
		}
		const newRenderer = this.webglAddon ? "webgl" : "canvas-fallback";
		console.log(
			`[terminal:${this.taskId}] renderer reset — previous: ${hadWebgl ? "webgl" : "none"}, new: ${newRenderer}, dpr: ${window.devicePixelRatio}`,
		);
	}

	getBufferDebugInfo(): {
		activeBuffer: "ALTERNATE" | "NORMAL";
		normalLength: number;
		normalBaseY: number;
		normalScrollbackLines: number;
		alternateLength: number;
		viewportRows: number;
		scrollbackOption: number;
		scrollOnEraseInDisplay: boolean;
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
			scrollOnEraseInDisplay: this.terminal.options.scrollOnEraseInDisplay ?? true,
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
		this.sendControlMessage({ type: "stop" });
		const trpcClient = getRuntimeTrpcClient(this.workspaceId);
		await trpcClient.runtime.stopTaskSession.mutate({ taskId: this.taskId });
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.unmount(this.visibleContainer);
		this.ioSocket?.close();
		this.controlSocket?.close();
		this.ioSocket = null;
		this.controlSocket = null;
		this.subscribers.clear();
		this.terminal.dispose();
		this.hostElement.remove();
	}
}
