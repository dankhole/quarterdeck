import type { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

import { applyTerminalInputFieldAttributes } from "@/terminal/terminal-helper-textarea";
import type { PersistentTerminalAppearance } from "@/terminal/terminal-options";
import {
	createQuarterdeckTerminalOptions,
	TERMINAL_FONT_SIZE,
	TERMINAL_PRIMARY_FONT,
} from "@/terminal/terminal-options";
import { createClientLogger } from "@/utils/client-logger";
import { isMacPlatform } from "@/utils/platform";

const log = createClientLogger("slot-renderer");

const FONT_READY_TIMEOUT_MS = 3000;

interface SlotRendererCallbacks {
	forceResize: () => void;
	getStageContainer: () => HTMLDivElement | null;
	getVisibleContainer: () => HTMLDivElement | null;
	isDisposed: () => boolean;
}

export class SlotRenderer {
	private webglAddon: WebglAddon | null = null;
	private dprMediaQuery: MediaQueryList | null = null;
	private dprChangeHandler: (() => void) | null = null;
	private dprRepairFrame: number | null = null;
	private disposed = false;

	constructor(
		private readonly slotId: number,
		private readonly terminal: Terminal,
		private readonly hostElement: HTMLDivElement,
		private readonly fitAddon: FitAddon,
		private readonly callbacks: SlotRendererCallbacks,
	) {}

	private get isDisposed(): boolean {
		return this.disposed || this.callbacks.isDisposed();
	}

	openWhenFontsReady(): void {
		const fontCheckString = `${TERMINAL_FONT_SIZE}px '${TERMINAL_PRIMARY_FONT}'`;
		const t0 = performance.now();

		const openAndAttachWebgl = () => {
			if (this.isDisposed) {
				return;
			}
			log.debug(`[perf] slot ${this.slotId} terminal.open`, { elapsedMs: (performance.now() - t0).toFixed(1) });
			this.terminal.open(this.hostElement);
			applyTerminalInputFieldAttributes(this.hostElement, this.slotId);
			this.attachWebglAddon();
			if (this.callbacks.getStageContainer() ?? this.callbacks.getVisibleContainer()) {
				this.fitAddon.fit();
			}
		};

		const refitAfterFontsReady = () => {
			void document.fonts.ready.then(() => {
				if (!this.isDisposed && (this.callbacks.getStageContainer() ?? this.callbacks.getVisibleContainer())) {
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

	attachWebglAddon(): void {
		if (this.isDisposed || this.webglAddon || !this.terminal.element) {
			return;
		}
		let candidate: WebglAddon | null = null;
		try {
			const webglAddon = new WebglAddon();
			candidate = webglAddon;
			this.webglAddon = webglAddon;
			webglAddon.onContextLoss(() => {
				if (this.webglAddon === webglAddon) {
					this.disposeWebglAddon();
				}
			});
			this.terminal.loadAddon(webglAddon);
		} catch {
			// Activation can fail after construction; retain xterm's DOM fallback.
			if (this.webglAddon === candidate) {
				this.disposeWebglAddon();
			}
		}
	}

	private disposeWebglAddon(): void {
		const webglAddon = this.webglAddon;
		this.webglAddon = null;
		webglAddon?.dispose();
	}

	updateAppearance(appearance: PersistentTerminalAppearance, fontWeight: number): void {
		this.terminal.options.theme = {
			...this.terminal.options.theme,
			...createQuarterdeckTerminalOptions({
				cursorColor: appearance.cursorColor,
				fontWeight,
				isMacPlatform,
				terminalBackgroundColor: appearance.terminalBackgroundColor,
			}).theme,
		};
	}

	setFontWeight(weight: number): void {
		this.terminal.options.fontWeight = weight;
	}

	listenForDprChange(): void {
		if (this.dprMediaQuery && this.dprChangeHandler) {
			this.dprMediaQuery.removeEventListener("change", this.dprChangeHandler);
		}
		if (this.isDisposed) {
			return;
		}
		const dpr = window.devicePixelRatio;
		const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
		const handler = () => {
			if (this.isDisposed || this.dprChangeHandler !== handler) {
				return;
			}
			this.listenForDprChange();
			if (this.dprRepairFrame === null) {
				// Let xterm's native DPR listeners update dimensions and models before fitting.
				const frame = requestAnimationFrame(() => {
					if (this.dprRepairFrame !== frame) {
						return;
					}
					this.dprRepairFrame = null;
					this.repairCanvas("dpr-change");
				});
				this.dprRepairFrame = frame;
			}
		};
		mq.addEventListener("change", handler, { once: true });
		this.dprMediaQuery = mq;
		this.dprChangeHandler = handler;
	}

	clearDprListener(): void {
		if (this.dprMediaQuery && this.dprChangeHandler) {
			this.dprMediaQuery.removeEventListener("change", this.dprChangeHandler);
		}
		this.dprMediaQuery = null;
		this.dprChangeHandler = null;
		this.cancelPendingDprRepair();
	}

	private cancelPendingDprRepair(): void {
		if (this.dprRepairFrame !== null) {
			cancelAnimationFrame(this.dprRepairFrame);
			this.dprRepairFrame = null;
		}
	}

	/** Refit and repaint only; xterm owns native DPR/model updates and the existing GPU context. */
	repairCanvas(trigger: string): void {
		this.cancelPendingDprRepair();
		if (this.isDisposed || !this.terminal.element || !this.callbacks.getVisibleContainer()) {
			return;
		}

		const t0 = performance.now();
		// Clearing xterm's shared atlas invalidates peers; a geometry bounce clamps the buffer cursor.
		this.fitAddon.fit();
		this.terminal.refresh(0, this.terminal.rows - 1);

		log.debug(`slot ${this.slotId} canvas repair`, {
			trigger,
			renderer: this.webglAddon ? "webgl" : "dom",
			dpr: window.devicePixelRatio,
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			elapsedMs: (performance.now() - t0).toFixed(1),
		});
	}

	resetRenderer(): void {
		this.cancelPendingDprRepair();
		if (this.isDisposed || !this.terminal.element || !this.callbacks.getVisibleContainer()) {
			return;
		}
		// Replacing a renderer allocates a context; reserve it for an explicit reset, never DPR changes.
		this.disposeWebglAddon();
		this.attachWebglAddon();
		this.repairCanvas("resetRenderer");
	}

	get hasWebgl(): boolean {
		return this.webglAddon !== null;
	}

	dispose(): void {
		this.disposed = true;
		this.clearDprListener();
		this.disposeWebglAddon();
	}
}
