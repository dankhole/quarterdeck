import type { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

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

	constructor(
		private readonly slotId: number,
		private readonly terminal: Terminal,
		private readonly hostElement: HTMLDivElement,
		private readonly fitAddon: FitAddon,
		private readonly callbacks: SlotRendererCallbacks,
	) {}

	openWhenFontsReady(): void {
		const fontCheckString = `${TERMINAL_FONT_SIZE}px '${TERMINAL_PRIMARY_FONT}'`;
		const t0 = performance.now();

		const openAndAttachWebgl = () => {
			if (this.callbacks.isDisposed()) {
				return;
			}
			log.debug(`[perf] slot ${this.slotId} terminal.open`, { elapsedMs: (performance.now() - t0).toFixed(1) });
			this.terminal.open(this.hostElement);
			this.attachWebglAddon();
			if (this.callbacks.getStageContainer() ?? this.callbacks.getVisibleContainer()) {
				this.fitAddon.fit();
			}
		};

		const refitAfterFontsReady = () => {
			void document.fonts.ready.then(() => {
				if (
					!this.callbacks.isDisposed() &&
					(this.callbacks.getStageContainer() ?? this.callbacks.getVisibleContainer())
				) {
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
		this.clearDprListener();
		const dpr = window.devicePixelRatio;
		const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
		const handler = () => {
			this.repairCanvas("dpr-change");
			this.listenForDprChange();
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
	}

	/**
	 * Canvas repair sequence — three steps that fix blurry/stale terminal
	 * rendering after a DPR change, monitor move, or DOM re-parent.
	 *
	 * 1. Dimension bounce — forces fitAddon to recalculate canvas pixel dimensions
	 * 2. clearTextureAtlas() — discards cached glyph textures for rebuild at current DPR
	 * 3. refresh(0, rows-1) — repaints every visible row with new textures
	 */
	repairCanvas(trigger: string): void {
		if (!this.callbacks.getStageContainer() && !this.callbacks.getVisibleContainer()) {
			log.debug(`slot ${this.slotId} canvas repair skipped — not staged`, { trigger });
			return;
		}

		const t0 = performance.now();
		const prevCols = this.terminal.cols;
		const prevRows = this.terminal.rows;

		if (prevCols > 2) {
			this.terminal.resize(prevCols - 1, prevRows);
		}

		this.terminal.clearTextureAtlas();
		this.terminal.refresh(0, prevRows - 1);
		this.callbacks.forceResize();

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
		this.repairCanvas("resetRenderer");
	}

	get hasWebgl(): boolean {
		return this.webglAddon !== null;
	}

	dispose(): void {
		this.clearDprListener();
		if (this.webglAddon) {
			this.webglAddon.dispose();
			this.webglAddon = null;
		}
	}
}
