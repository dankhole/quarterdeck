import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import type { RuntimeTerminalWsClientMessage } from "@/runtime/types";
import { SlotDomHost } from "@/terminal/slot-dom-host";
import { SlotRenderer } from "@/terminal/slot-renderer";
import { SlotResizeManager } from "@/terminal/slot-resize-manager";
import { SlotWriteQueue } from "@/terminal/slot-write-queue";
import { TERMINAL_SCROLLBACK } from "@/terminal/terminal-constants";
import { createQuarterdeckTerminalOptions, type PersistentTerminalAppearance } from "@/terminal/terminal-options";
import { shouldSkipEmptyRestoreSnapshot } from "@/terminal/terminal-restore-policy";
import { isCopyShortcut } from "@/terminal/terminal-socket-utils";
import type { TerminalWriteOptions } from "@/terminal/terminal-write-options";
import { createClientLogger } from "@/utils/client-logger";
import { isMacPlatform } from "@/utils/platform";

const log = createClientLogger("terminal-viewport");

const SHIFT_ENTER_SEQUENCE = "\n";

let currentTerminalFontWeight: number = CONFIG_DEFAULTS.terminalFontWeight;

export type { PersistentTerminalAppearance } from "@/terminal/terminal-options";

export function updateGlobalTerminalFontWeight(weight: number): void {
	currentTerminalFontWeight = weight;
}

interface TerminalViewportCallbacks {
	clearGeometry: (taskId: string) => void;
	getConnectedTaskId: () => string | null;
	isDisposed: () => boolean;
	notifyOutputText: (text: string) => void;
	reportGeometry: (taskId: string, geometry: { cols: number; rows: number }) => void;
	sendControlMessage: (msg: RuntimeTerminalWsClientMessage) => boolean;
	sendIoData: (data: string | Uint8Array) => boolean;
}

export class TerminalViewport {
	private readonly terminal: Terminal;
	private readonly fitAddon = new FitAddon();
	private readonly domHost = new SlotDomHost();
	private readonly renderer: SlotRenderer;
	private readonly resizer: SlotResizeManager;
	private readonly unicode11Addon = new Unicode11Addon();
	private readonly writeQueue: SlotWriteQueue;
	private pendingAutoFocus = false;
	private revealFrame: {
		id: number;
		resolve: (completed: boolean) => void;
	} | null = null;
	private revealSequence = 0;
	private appearance: PersistentTerminalAppearance;

	constructor(
		private readonly slotId: number,
		appearance: PersistentTerminalAppearance,
		private readonly callbacks: TerminalViewportCallbacks,
	) {
		this.appearance = appearance;
		this.terminal = this.createTerminal();
		this.writeQueue = this.createWriteQueue();
		this.initializeTerminalAddons();
		this.configureTerminalIoForwarding();
		this.configureCustomKeyHandling();
		this.renderer = this.createRenderer();
		this.resizer = this.createResizeManager();
		this.renderer.openWhenFontsReady();
	}

	get visibleContainer(): HTMLDivElement | null {
		return this.domHost.visibleContainer;
	}

	get stageContainer(): HTMLDivElement | null {
		return this.domHost.stageContainer;
	}

	private createTerminal(): Terminal {
		const initialGeometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);
		return new Terminal({
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
	}

	private createWriteQueue(): SlotWriteQueue {
		return new SlotWriteQueue(this.terminal, {
			sendControlMessage: (msg) => this.callbacks.sendControlMessage(msg),
			notifyOutputText: (text) => this.callbacks.notifyOutputText(text),
			isDisposed: () => this.callbacks.isDisposed(),
		});
	}

	private initializeTerminalAddons(): void {
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(new ClipboardAddon());
		this.terminal.loadAddon(new WebLinksAddon());
		this.terminal.loadAddon(this.unicode11Addon);
		this.terminal.unicode.activeVersion = "11";
	}

	private configureTerminalIoForwarding(): void {
		this.terminal.onData((data) => {
			this.callbacks.sendIoData(data);
		});
		this.terminal.onBinary((data) => {
			const bytes = new Uint8Array(data.length);
			for (let index = 0; index < data.length; index += 1) {
				bytes[index] = data.charCodeAt(index) & 0xff;
			}
			this.callbacks.sendIoData(bytes);
		});
	}

	private configureCustomKeyHandling(): void {
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
	}

	private createRenderer(): SlotRenderer {
		return new SlotRenderer(this.slotId, this.terminal, this.domHost.hostElement, this.fitAddon, {
			forceResize: () => this.forceResize(),
			getStageContainer: () => this.stageContainer,
			getVisibleContainer: () => this.visibleContainer,
			isDisposed: () => this.callbacks.isDisposed(),
		});
	}

	private createResizeManager(): SlotResizeManager {
		return new SlotResizeManager(this.terminal, this.fitAddon, {
			sendControlMessage: (msg) => this.callbacks.sendControlMessage(msg),
			reportGeometry: (taskId, geometry) => this.callbacks.reportGeometry(taskId, geometry),
			getConnectedTaskId: () => this.callbacks.getConnectedTaskId(),
			getVisibleContainer: () => this.visibleContainer,
			getStageContainer: () => this.stageContainer,
		});
	}

	private updateAppearance(appearance: PersistentTerminalAppearance): void {
		this.appearance = appearance;
		this.renderer.updateAppearance(appearance, currentTerminalFontWeight);
	}

	private cancelPendingReveal(): void {
		this.revealSequence += 1;
		if (this.revealFrame !== null) {
			const frame = this.revealFrame;
			cancelAnimationFrame(frame.id);
			this.revealFrame = null;
			frame.resolve(false);
		}
	}

	private waitForRevealFrame(sequence: number): Promise<boolean> {
		return new Promise((resolve) => {
			const id = requestAnimationFrame(() => {
				if (this.revealFrame?.id === id) {
					this.revealFrame = null;
				}
				resolve(this.revealSequence === sequence);
			});
			this.revealFrame = { id, resolve };
		});
	}

	private canCompleteReveal(sequence: number): boolean {
		return !this.callbacks.isDisposed() && this.revealSequence === sequence && this.visibleContainer !== null;
	}

	async revealAfterLayout(options: { autoFocus?: boolean } = {}): Promise<boolean> {
		this.cancelPendingReveal();
		const sequence = this.revealSequence;
		if (this.callbacks.isDisposed()) {
			return false;
		}
		if (this.visibleContainer === null) {
			return true;
		}

		this.resizer.pendingScrollToBottom = true;
		for (let pass = 0; pass < 2; pass += 1) {
			if (!(await this.waitForRevealFrame(sequence)) || !this.canCompleteReveal(sequence)) {
				return !this.callbacks.isDisposed() && this.visibleContainer === null;
			}
			await this.writeQueue.drain();
			if (!this.canCompleteReveal(sequence)) {
				return !this.callbacks.isDisposed() && this.visibleContainer === null;
			}
			this.resizer.request();
			this.terminal.scrollToBottom();
		}

		this.resizer.pendingScrollToBottom = false;
		this.domHost.reveal();
		if (options.autoFocus) {
			this.terminal.focus();
		}
		return true;
	}

	ensureVisible(): void {
		void this.revealAfterLayout();
	}

	invalidateResize(): void {
		this.resizer.invalidate();
	}

	requestResize(force?: boolean): void {
		this.resizer.request(force);
	}

	forceResize(): void {
		this.resizer.force();
	}

	async drainWrites(): Promise<void> {
		await this.writeQueue.drain();
	}

	async enqueueWrite(data: string | Uint8Array, options?: TerminalWriteOptions): Promise<void> {
		await this.writeQueue.enqueue(data, options);
	}

	async applyRestoreSnapshot(
		snapshot: string,
		cols: number | null | undefined,
		rows: number | null | undefined,
	): Promise<void> {
		this.resizer.invalidate();
		// Live IO output and control restore messages can race. Drain queued
		// writes before deciding whether an empty restore is safe; otherwise an
		// empty stale snapshot can reset content that has reached the queue but
		// not xterm yet.
		await this.writeQueue.drain();
		if (shouldSkipEmptyRestoreSnapshot(snapshot, this.readBufferLines())) {
			log.warn(`slot ${this.slotId} skipped empty restore over non-empty terminal buffer`, {
				taskId: this.callbacks.getConnectedTaskId(),
			});
			return;
		}
		this.terminal.reset();
		if (cols && rows && (this.terminal.cols !== cols || this.terminal.rows !== rows)) {
			this.terminal.resize(cols, rows);
		}
		if (snapshot) {
			await this.writeQueue.enqueue(snapshot);
		}
	}

	async finalizeRestorePresentation(options: { hasActiveIoSocket: boolean }): Promise<boolean> {
		if (options.hasActiveIoSocket && (this.visibleContainer ?? this.stageContainer)) {
			this.resizer.request();
		}
		this.terminal.scrollToBottom();
		this.resizer.pendingScrollToBottom = true;
		const presentationSettled = await this.revealAfterLayout({ autoFocus: this.pendingAutoFocus });
		this.pendingAutoFocus = false;
		return options.hasActiveIoSocket && presentationSettled;
	}

	attachToStageContainer(container: HTMLDivElement): void {
		if (this.callbacks.isDisposed()) {
			return;
		}
		if (this.stageContainer === container) {
			return;
		}
		const { hadPreviousStage } = this.domHost.attachToStageContainer(container);
		this.fitAddon.fit();
		log.debug(`slot ${this.slotId} staged`, {
			reparent: hadPreviousStage,
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		});
	}

	show(
		appearance: PersistentTerminalAppearance,
		options: { autoFocus?: boolean; isVisible?: boolean; restoreCompleted: boolean },
	): void {
		if (this.callbacks.isDisposed()) {
			return;
		}
		this.updateAppearance(appearance);
		this.terminal.refresh(0, this.terminal.rows - 1);
		this.domHost.markVisible();
		if (this.stageContainer) {
			this.resizer.observe(this.stageContainer);
		} else {
			log.warn(`slot ${this.slotId} show — no stageContainer, ResizeObserver not attached`);
		}
		this.renderer.listenForDprChange();
		if (options.isVisible !== false) {
			this.resizer.request();
			if (options.restoreCompleted) {
				this.terminal.scrollToBottom();
				this.resizer.pendingScrollToBottom = true;
			}
			if (options.autoFocus) {
				this.pendingAutoFocus = true;
			}
		}
		if (options.restoreCompleted && options.isVisible !== false) {
			void this.revealAfterLayout({ autoFocus: this.pendingAutoFocus });
			this.pendingAutoFocus = false;
		}
	}

	hide(): void {
		if (this.callbacks.isDisposed() && this.visibleContainer === null) {
			return;
		}
		this.cancelPendingReveal();
		this.resizer.disconnect();
		this.renderer.clearDprListener();
		this.pendingAutoFocus = false;
		const taskId = this.callbacks.getConnectedTaskId();
		if (taskId) {
			this.callbacks.clearGeometry(taskId);
		}
		this.domHost.hide();
	}

	park(): void {
		if (this.callbacks.isDisposed()) {
			return;
		}
		this.cancelPendingReveal();
		this.domHost.park();
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.updateAppearance(appearance);
	}

	setFontWeight(weight: number): void {
		this.renderer.setFontWeight(weight);
	}

	writeText(text: string): void {
		if (this.callbacks.isDisposed()) {
			return;
		}
		void this.writeQueue.enqueue(text);
	}

	resetBuffer(): void {
		this.writeQueue.chainAction(
			(terminal) => terminal.reset(),
			() => this.callbacks.isDisposed(),
		);
	}

	input(text: string): void {
		this.terminal.input(text);
	}

	paste(text: string): void {
		this.terminal.paste(text);
	}

	clear(): void {
		this.writeQueue.chainAction(
			(terminal) => terminal.clear(),
			() => this.callbacks.isDisposed(),
		);
	}

	reset(): void {
		this.writeQueue.chainAction(
			(terminal) => terminal.reset(),
			() => this.callbacks.isDisposed(),
		);
	}

	resetRenderer(): void {
		this.renderer.resetRenderer();
	}

	focus(): void {
		this.terminal.focus();
	}

	refreshVisibleRows(): void {
		this.terminal.refresh(0, this.terminal.rows - 1);
	}

	readBufferLines(): string[] {
		const buffer = this.terminal.buffer.active;
		const baseY = buffer.baseY;
		const rows = this.terminal.rows;
		const result: string[] = [];
		for (let index = baseY; index < baseY + rows; index += 1) {
			const line = buffer.getLine(index);
			result.push(line ? line.translateToString(true) : "");
		}
		while (result.length > 0 && result[result.length - 1]!.trim() === "") {
			result.pop();
		}
		return result;
	}

	getBufferDebugInfo(sessionState: string | null): {
		activeBuffer: "ALTERNATE" | "NORMAL";
		normalLength: number;
		normalBaseY: number;
		normalScrollbackLines: number;
		alternateLength: number;
		viewportRows: number;
		scrollbackOption: number;
		sessionState: string | null;
	} {
		const buffer = this.terminal.buffer;
		const isAlt = buffer.active.type === "alternate";
		return {
			activeBuffer: isAlt ? "ALTERNATE" : "NORMAL",
			normalLength: buffer.normal.length,
			normalBaseY: buffer.normal.baseY,
			normalScrollbackLines: buffer.normal.length - this.terminal.rows,
			alternateLength: buffer.alternate.length,
			viewportRows: this.terminal.rows,
			scrollbackOption: this.terminal.options.scrollback ?? 0,
			sessionState,
		};
	}

	dispose(): void {
		this.cancelPendingReveal();
		this.resizer.disconnect();
		this.renderer.dispose();
		this.domHost.dispose();
		this.terminal.dispose();
	}
}
