import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { SlotRenderer } from "@/terminal/slot-renderer";
import { SlotResizeManager } from "@/terminal/slot-resize-manager";
import { SlotSocketManager } from "@/terminal/slot-socket-manager";
import { SlotWriteQueue } from "@/terminal/slot-write-queue";
import { TERMINAL_SCROLLBACK } from "@/terminal/terminal-constants";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { createQuarterdeckTerminalOptions, type PersistentTerminalAppearance } from "@/terminal/terminal-options";
import {
	appendTerminalHeuristicText,
	hasInterruptAcknowledgement,
	hasLikelyShellPrompt,
} from "@/terminal/terminal-prompt-heuristics";
import { generateTerminalClientId, isCopyShortcut } from "@/terminal/terminal-socket-utils";
import { createClientLogger } from "@/utils/client-logger";
import { isMacPlatform } from "@/utils/platform";

const log = createClientLogger("terminal-slot");

const SHIFT_ENTER_SEQUENCE = "\n";
const INTERRUPT_IDLE_SETTLE_MS = 250;
const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";

export { TERMINAL_SCROLLBACK } from "@/terminal/terminal-constants";
export type { PersistentTerminalAppearance } from "@/terminal/terminal-options";

let currentTerminalFontWeight: number = CONFIG_DEFAULTS.terminalFontWeight;

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
	private readonly resizer: SlotResizeManager;
	private readonly renderer: SlotRenderer;
	private visibleContainer: HTMLDivElement | null = null;
	/** The container the hostElement is physically in the DOM (set by pool or dedicated caller). */
	private stageContainer: HTMLDivElement | null = null;
	private readonly sockets: SlotSocketManager;
	/** Deferred focus — set by show() when autoFocus is requested before restore completes. */
	private pendingAutoFocus = false;
	private readonly writeQueue: SlotWriteQueue;
	private disposed = false;
	/** One-shot callback fired when notifyConnectionReady() runs, then cleared. */
	private onceConnectionReadyCallback: (() => void) | null = null;
	private visibilityChangeHandler: (() => void) | null = null;
	private connectTimestamp: number | null = null;
	private showTimestamp: number | null = null;
	private restoreRequestTimestamp: number | null = null;

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
		this.sockets = new SlotSocketManager(this.slotId, this.clientId, {
			enqueueWrite: (data, options) => {
				void this.writeQueue.enqueue(data, options);
			},
			onRestore: (snapshot, cols, rows) => this.handleRestore(snapshot, cols, rows),
			onState: (payload) => this.handleState(payload),
			onExit: (code) => this.handleExit(code),
			onError: (message) => {
				void this.writeQueue.enqueue(`\r\n[quarterdeck] ${message}\r\n`);
			},
			onConnectionReady: () => this.notifyConnectionReady(),
			onLastError: (message) => {
				this.lastError = message;
				this.notifyLastError();
			},
			ensureVisible: () => this.ensureVisible(),
			invalidateResize: () => this.resizer.invalidate(),
			requestResize: () => this.resizer.request(),
			getVisibleContainer: () => this.visibleContainer,
			getStageContainer: () => this.stageContainer,
			isDisposed: () => this.disposed,
		});
		this.writeQueue = new SlotWriteQueue(this.terminal, {
			sendControlMessage: (msg) => this.sockets.sendControl(msg),
			notifyOutputText: (text) => this.notifyOutputText(text),
			isDisposed: () => this.disposed,
		});
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(new ClipboardAddon());
		this.terminal.loadAddon(new WebLinksAddon());
		this.terminal.loadAddon(this.unicode11Addon);
		this.terminal.unicode.activeVersion = "11";
		this.terminal.onData((data) => {
			this.sockets.sendIo(data);
		});
		this.terminal.onBinary((data) => {
			const bytes = new Uint8Array(data.length);
			for (let index = 0; index < data.length; index += 1) {
				bytes[index] = data.charCodeAt(index) & 0xff;
			}
			this.sockets.sendIo(bytes);
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

		this.renderer = new SlotRenderer(this.slotId, this.terminal, this.hostElement, this.fitAddon, {
			forceResize: () => this.forceResize(),
			getStageContainer: () => this.stageContainer,
			getVisibleContainer: () => this.visibleContainer,
			isDisposed: () => this.disposed,
		});
		this.resizer = new SlotResizeManager(this.terminal, this.fitAddon, {
			sendControlMessage: (msg) => this.sockets.sendControl(msg),
			reportGeometry: reportTerminalGeometry,
			getConnectedTaskId: () => this.connectedTaskId,
			getVisibleContainer: () => this.visibleContainer,
			getStageContainer: () => this.stageContainer,
		});
		this.renderer.openWhenFontsReady();
		// Repaint when the browser tab returns to foreground — GPU may have evicted
		// textures or skipped frames while backgrounded. Also reconnect dead sockets
		// (e.g. after the computer wakes from sleep).
		this.visibilityChangeHandler = () => {
			if (document.visibilityState === "visible" && this.visibleContainer && !this.disposed) {
				log.debug(`slot ${this.slotId} tab-return refresh`, { task: this.taskId });
				this.terminal.refresh(0, this.terminal.rows - 1);
				// Reconnect sockets that died during sleep/background.
				if (this.taskId && this.workspaceId && (!this.sockets.hasIoSocket || !this.sockets.hasControlSocket)) {
					log.info(`slot ${this.slotId} tab-return reconnecting dead sockets`, { task: this.taskId });
					this.sockets.connectIo(this.taskId, this.workspaceId);
					this.sockets.connectControl(this.taskId, this.workspaceId);
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
		this.sockets.connectIo(this.taskId, this.workspaceId);
		this.sockets.connectControl(this.taskId, this.workspaceId);
	}

	connectToTask(taskId: string, workspaceId: string): void {
		if (this.disposed) {
			return;
		}
		if (this.taskId === taskId && this.workspaceId === workspaceId) {
			return;
		}
		if (this.taskId) {
			this.sockets.closeAll();
		}
		this.taskId = taskId;
		this.workspaceId = workspaceId;
		this.connectTimestamp = performance.now();
		this.sockets.connectIo(taskId, workspaceId);
		this.sockets.connectControl(taskId, workspaceId);
	}

	async disconnectFromTask(): Promise<void> {
		if (!this.taskId) {
			return;
		}
		const previousTaskId = this.taskId;

		this.sockets.closeAll();

		// Clear ALL task-specific state synchronously before any await.
		// The pool may reuse this slot immediately via connectToTask() — if state
		// mutation happened after the await, the async tail would clobber the new
		// task's connection (taskId, subscribers, buffer).
		this.sockets.resetConnectionState();
		this.pendingAutoFocus = false;
		this.latestSummary = null;
		this.lastError = null;
		this.restoreRequestTimestamp = null;
		clearTerminalGeometry(previousTaskId);
		this.taskId = null;
		this.workspaceId = null;
		this.subscribers.clear();
		this.onceConnectionReadyCallback = null;

		await this.writeQueue.drain();
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
		this.sockets.connectionReady = true;
		if (this.connectTimestamp !== null) {
			log.debug(`[perf] slot ${this.slotId} connect-to-ready`, {
				elapsedMs: (performance.now() - this.connectTimestamp).toFixed(1),
			});
			this.connectTimestamp = null;
		}
		if (this.showTimestamp !== null) {
			log.debug(`[perf] slot ${this.slotId} show-to-interactive`, {
				elapsedMs: (performance.now() - this.showTimestamp).toFixed(1),
			});
			this.showTimestamp = null;
		}
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

	/** Reveal the host element if it was deferred during restore. */
	private ensureVisible(): void {
		if (this.visibleContainer) {
			this.hostElement.style.visibility = "visible";
		}
	}

	private forceResize(): void {
		this.resizer.force();
	}

	private async handleRestore(
		snapshot: string,
		cols: number | null | undefined,
		rows: number | null | undefined,
	): Promise<void> {
		const t0 = performance.now();
		this.resizer.invalidate();
		await this.writeQueue.drain();
		this.terminal.reset();
		if (cols && rows && (this.terminal.cols !== cols || this.terminal.rows !== rows)) {
			this.terminal.resize(cols, rows);
		}
		if (snapshot) {
			await this.writeQueue.enqueue(snapshot);
		}
		log.debug(`[perf] slot ${this.slotId} restore applied`, {
			elapsedMs: (performance.now() - t0).toFixed(1),
			snapshotLength: snapshot.length,
		});
		if (this.restoreRequestTimestamp !== null) {
			log.debug(`[perf] slot ${this.slotId} restore round-trip`, {
				elapsedMs: (performance.now() - this.restoreRequestTimestamp).toFixed(1),
			});
			this.restoreRequestTimestamp = null;
		}
		// Post-restore: fit BEFORE reveal so scroll position is correct.
		if (this.sockets.hasIoSocket && (this.visibleContainer ?? this.stageContainer)) {
			this.resizer.request();
		}
		this.terminal.scrollToBottom();
		this.resizer.pendingScrollToBottom = true;
		this.ensureVisible();
		if (this.pendingAutoFocus) {
			this.pendingAutoFocus = false;
			this.terminal.focus();
		}
		if (this.sockets.hasIoSocket) {
			this.notifyConnectionReady();
		}
	}

	private handleState(payload: { type: "state"; summary: RuntimeTaskSessionSummary }): void {
		const previousState = this.latestSummary?.state;
		this.notifySummary(payload.summary);
		if (
			(this.visibleContainer ?? this.stageContainer) &&
			payload.summary.state !== previousState &&
			previousState !== "running" &&
			previousState !== "awaiting_review" &&
			(payload.summary.state === "running" || payload.summary.state === "awaiting_review")
		) {
			this.forceResize();
		}
	}

	private handleExit(code: number | null): void {
		const label = code == null ? "session exited" : `session exited with code ${code}`;
		void this.writeQueue.enqueue(`\r\n[quarterdeck] ${label}\r\n`);
		this.notifyExit(code);
	}

	private updateAppearance(appearance: PersistentTerminalAppearance): void {
		this.appearance = appearance;
		this.renderer.updateAppearance(appearance, currentTerminalFontWeight);
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.updateAppearance(appearance);
	}

	setFontWeight(weight: number): void {
		this.renderer.setFontWeight(weight);
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
		if (this.sockets.connectionReady && this.taskId) {
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
		this.showTimestamp = performance.now();
		this.updateAppearance(appearance);

		// Defer visibility when a restore snapshot is pending — the full history
		// would otherwise scroll past as xterm renders it incrementally. The
		// restore handler sets visibility = "visible" after scrollToBottom().
		const shouldReveal = this.sockets.restoreCompleted;
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

		if (this.stageContainer) {
			this.resizer.observe(this.stageContainer);
		} else {
			log.warn(`slot ${this.slotId} show — no stageContainer, ResizeObserver not attached`);
		}
		this.renderer.listenForDprChange();
		if (options.isVisible !== false) {
			// Fit + scroll BEFORE revealing to avoid a visible frame at the
			// old scroll position. fit() may reflow the buffer when cols/rows
			// change, so scrollToBottom must come after it.
			this.resizer.request();
			if (shouldReveal) {
				this.terminal.scrollToBottom();
				// Arm a one-shot for the first ResizeObserver callback in case
				// its fit() reflow undoes this scroll.
				this.resizer.pendingScrollToBottom = true;
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
		log.debug(`[perf] slot ${this.slotId} show complete`, {
			elapsedMs: (performance.now() - this.showTimestamp!).toFixed(1),
			revealed: shouldReveal,
			task: this.taskId,
		});
	}

	hide(): void {
		if (this.disposed && this.visibleContainer === null) {
			return;
		}
		log.debug(`slot ${this.slotId} hide`, { task: this.taskId });
		this.resizer.disconnect();
		this.renderer.clearDprListener();
		this.pendingAutoFocus = false;
		this.visibleContainer = null;
		if (this.connectedTaskId) {
			clearTerminalGeometry(this.connectedTaskId);
		}
		this.hostElement.style.visibility = "hidden";
	}

	/**
	 * Move the host element back to the off-screen parking root and clear the
	 * stage container reference. Call this when the DOM container that held the
	 * terminal is about to be removed (e.g. dedicated terminal panel unmount)
	 * so the xterm canvas stays in the live DOM and avoids WebGL context loss.
	 */
	park(): void {
		if (this.disposed) return;
		log.debug(`slot ${this.slotId} parked`, { task: this.taskId });
		this.stageContainer = null;
		this.parkingRoot.appendChild(this.hostElement);
	}

	get sessionState(): string | null {
		return this.latestSummary?.state ?? null;
	}

	writeText(text: string): void {
		if (this.disposed) {
			return;
		}
		void this.writeQueue.enqueue(text);
	}

	focus(): void {
		this.terminal.focus();
	}

	input(text: string): boolean {
		if (!this.sockets.isIoOpen) {
			return false;
		}
		this.terminal.input(text);
		return true;
	}

	paste(text: string): boolean {
		if (!this.sockets.isIoOpen) {
			return false;
		}
		this.terminal.paste(text);
		return true;
	}

	clear(): void {
		this.writeQueue.chainAction(
			(t) => t.clear(),
			() => this.disposed,
		);
	}

	reset(): void {
		this.writeQueue.chainAction(
			(t) => t.reset(),
			() => this.disposed,
		);
	}

	resetRenderer(): void {
		this.renderer.resetRenderer();
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
		this.restoreRequestTimestamp = performance.now();
		this.sockets.requestRestore();
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
		this.sockets.sendControl({ type: "stop" });
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
		this.sockets.closeAll();
		this.subscribers.clear();
		this.onceConnectionReadyCallback = null;
		this.terminal.dispose();
		this.hostElement.remove();
	}
}
