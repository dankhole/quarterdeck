import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import type { RuntimeTerminalWsClientMessage } from "@/runtime/types";

const RESIZE_DEBOUNCE_MS = 50;

interface SlotResizeCallbacks {
	sendControlMessage: (msg: RuntimeTerminalWsClientMessage) => boolean;
	reportGeometry: (taskId: string, geometry: { cols: number; rows: number }) => void;
	getConnectedTaskId: () => string | null;
	getVisibleContainer: () => HTMLDivElement | null;
	getStageContainer: () => HTMLDivElement | null;
}

export class SlotResizeManager {
	private resizeEpoch = 0;
	private lastSatisfiedResizeEpoch = -1;
	private lastSentCols = 0;
	private lastSentRows = 0;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private _pendingScrollToBottom = false;
	private pendingInitialFit = false;

	constructor(
		private readonly terminal: Terminal,
		private readonly fitAddon: FitAddon,
		private readonly callbacks: SlotResizeCallbacks,
	) {}

	get pendingScrollToBottom(): boolean {
		return this._pendingScrollToBottom;
	}

	set pendingScrollToBottom(value: boolean) {
		this._pendingScrollToBottom = value;
	}

	invalidate(): void {
		this.resizeEpoch += 1;
	}

	force(): void {
		this.invalidate();
		this.request(true);
	}

	request(force?: boolean): void {
		const taskId = this.callbacks.getConnectedTaskId();
		if (!taskId) {
			return;
		}
		const container = this.callbacks.getVisibleContainer() ?? this.callbacks.getStageContainer();
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
		this.callbacks.reportGeometry(taskId, { cols, rows });
		const sent = this.callbacks.sendControlMessage({
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

	observe(container: HTMLDivElement): void {
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
		}
		this.pendingInitialFit = true;
		this.resizeObserver = new ResizeObserver(() => {
			// First observation after observe(): do one immediate correction
			// pass so the terminal gets real container dimensions on the first
			// frame (prevents half-width on mount/untrash). Skip the debounce.
			if (this.pendingInitialFit) {
				this.pendingInitialFit = false;
				if (this._pendingScrollToBottom) {
					this.fitAddon.fit();
					this.terminal.scrollToBottom();
					this._pendingScrollToBottom = false;
				}
				this.request();
				return;
			}
			// When pendingScrollToBottom is armed, fit + scroll synchronously
			// in the same frame so the user never sees wrong scroll position.
			if (this._pendingScrollToBottom) {
				this.fitAddon.fit();
				this.terminal.scrollToBottom();
				this._pendingScrollToBottom = false;
			}
			if (this.resizeTimer !== null) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.request();
			}, RESIZE_DEBOUNCE_MS);
		});
		this.resizeObserver.observe(container);
	}

	disconnect(): void {
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.resizeTimer !== null) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		this.pendingInitialFit = false;
	}
}
