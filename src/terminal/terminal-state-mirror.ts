import headlessTerminalModule, { type Terminal as HeadlessTerminal } from "@xterm/headless";

import { createTaggedLogger } from "../core";
import { SerializeAddon } from "./xterm-serialize";

const log = createTaggedLogger("terminal-mirror");

const { Terminal } = headlessTerminalModule as { Terminal: typeof HeadlessTerminal };

/** Must match web-ui/src/terminal/terminal-slot.ts TERMINAL_SCROLLBACK */
const TERMINAL_SCROLLBACK = 1_500;

/**
 * Minimum scrollback for the headless xterm terminal, even when snapshot
 * serialization uses scrollback: 0.  xterm.js 6.x has a buffer-overflow bug
 * in its lineFeed handler: with scrollback 0 the circular buffer has exactly
 * `rows` entries, and certain cursor-positioning sequences can push
 * `ybase + y` past that limit, causing a fatal "Cannot set properties of
 * undefined (setting 'isWrapped')" inside an internal setTimeout — which
 * escapes all Promise / try-catch handling and crashes the process.
 *
 * Giving the terminal a small scrollback cushion keeps the buffer large
 * enough for xterm's internal bookkeeping while snapshot serialization
 * remains at the caller-requested level.
 */
const MINIMUM_TERMINAL_SCROLLBACK = 100;

const BATCH_FLUSH_INTERVAL_MS = 160;

export interface TerminalRestoreSnapshot {
	snapshot: string;
	cols: number;
	rows: number;
}

/** Rendered primary/alternate-screen viewport after an output write settles. */
export interface TerminalScreenSnapshot {
	lines: string[];
	cursorRow: number;
	cols: number;
	rows: number;
}

export interface TerminalStateMirrorDiagnosticSnapshot {
	disposed: boolean;
	batching: boolean;
	pendingBatchBytes: number;
	cols: number;
	rows: number;
}

interface TerminalStateMirrorOptions {
	onInputResponse?: (data: string) => void;
	/**
	 * Scrollback line count for the mirror terminal and snapshot serialization.
	 * Defaults to {@link TERMINAL_SCROLLBACK} (1,500). The terminal itself
	 * always gets at least {@link MINIMUM_TERMINAL_SCROLLBACK} lines to avoid
	 * an xterm.js 6.x circular-buffer crash.
	 */
	scrollback?: number;
}

export class TerminalStateMirror {
	private readonly terminal: InstanceType<typeof Terminal>;
	private readonly serializeAddon = new SerializeAddon();
	private operationQueue: Promise<void> = Promise.resolve();
	private disposed = false;
	private mouseEncodingMode: 0 | 1006 | 1016 = 0;

	private readonly snapshotScrollback: number;

	private batching = false;
	private batchBuffer: Uint8Array[] = [];
	private batchAppliedCallbacks: Array<(screen: TerminalScreenSnapshot) => void> = [];
	private batchTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Output queued behind an in-flight operation but not yet written. Later
	 * chunks join it so a burst costs one headless write (and one completion
	 * callback) instead of one serialized write per chunk. Every applied
	 * callback in the group sees the same final screen. Any other enqueued
	 * operation closes the group so output never jumps ahead of it.
	 */
	private pendingWrite: {
		chunks: Uint8Array[];
		callbacks: Array<(screen: TerminalScreenSnapshot) => void>;
	} | null = null;

	constructor(cols: number, rows: number, options: TerminalStateMirrorOptions = {}) {
		const scrollback = options.scrollback ?? TERMINAL_SCROLLBACK;
		this.snapshotScrollback = scrollback;
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols,
			rows,
			scrollback: Math.max(scrollback, MINIMUM_TERMINAL_SCROLLBACK),
			scrollOnEraseInDisplay: true,
		});
		this.terminal.loadAddon(this.serializeAddon);
		// SerializeAddon preserves mouse tracking, but omits its encoding. A
		// restored viewer would otherwise send legacy mouse bytes to a provider
		// expecting SGR, which can turn mouse movement into composer text.
		for (const final of ["h", "l"]) {
			this.terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
				for (const param of params) {
					const mode = Array.isArray(param) ? param[0] : param;
					if (mode === 1006 || mode === 1016) {
						this.mouseEncodingMode = final === "h" ? mode : 0;
					}
				}
				return false;
			});
		}
		this.terminal.parser.registerEscHandler({ final: "c" }, () => {
			this.mouseEncodingMode = 0;
			return false;
		});
		this.terminal.onData((data) => {
			options.onInputResponse?.(data);
		});
	}

	setBatching(enabled: boolean): void {
		if (this.batching === enabled) return;
		this.batching = enabled;
		if (!enabled) {
			this.flushBatch();
		}
	}

	applyOutput(chunk: Buffer, onApplied?: (screen: TerminalScreenSnapshot) => void): void {
		if (this.disposed) return;

		if (this.batching) {
			this.batchBuffer.push(new Uint8Array(chunk));
			if (onApplied) {
				this.batchAppliedCallbacks.push(onApplied);
			}
			if (this.batchTimer === null) {
				this.batchTimer = setTimeout(() => this.flushBatch(), BATCH_FLUSH_INTERVAL_MS);
			}
			return;
		}

		const chunkCopy = new Uint8Array(chunk);
		if (this.pendingWrite) {
			this.pendingWrite.chunks.push(chunkCopy);
			if (onApplied) this.pendingWrite.callbacks.push(onApplied);
			return;
		}
		const group = { chunks: [chunkCopy], callbacks: onApplied ? [onApplied] : [] };
		this.enqueueOperation(() => {
			if (this.pendingWrite === group) this.pendingWrite = null;
			return this.writeAndNotify(mergeChunks(group.chunks), group.callbacks);
		});
		this.pendingWrite = group;
	}

	resize(cols: number, rows: number): void {
		if (this.disposed) return;
		if (cols === this.terminal.cols && rows === this.terminal.rows) {
			return;
		}
		this.enqueueOperation(() => {
			this.terminal.resize(cols, rows);
		});
	}

	async getSnapshot(): Promise<TerminalRestoreSnapshot | null> {
		const t0 = performance.now();
		this.flushBatch();
		await this.operationQueue;
		const t1 = performance.now();
		if (this.disposed) {
			return null;
		}
		const mouseEncoding = this.mouseEncodingMode === 0 ? "" : `\u001b[?${this.mouseEncodingMode}h`;
		const snapshot = this.serializeAddon.serialize({ scrollback: this.snapshotScrollback }) + mouseEncoding;
		const t2 = performance.now();
		const cols = this.terminal.cols;
		const rows = this.terminal.rows;
		log.debug("[perf] getSnapshot", {
			queueDrainMs: Math.round((t1 - t0) * 100) / 100,
			serializeMs: Math.round((t2 - t1) * 100) / 100,
			totalMs: Math.round((t2 - t0) * 100) / 100,
			snapshotLength: snapshot.length,
			cols,
			rows,
		});
		return { snapshot, cols, rows };
	}

	getDiagnosticSnapshot(): TerminalStateMirrorDiagnosticSnapshot {
		return {
			disposed: this.disposed,
			batching: this.batching,
			pendingBatchBytes: this.batchBuffer.reduce((total, chunk) => total + chunk.byteLength, 0),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
	}

	dispose(): void {
		this.disposed = true;
		if (this.batchTimer !== null) {
			clearTimeout(this.batchTimer);
			this.batchTimer = null;
		}
		this.batchBuffer.length = 0;
		this.batchAppliedCallbacks.length = 0;
		this.pendingWrite = null;
		this.terminal.dispose();
	}

	private flushBatch(): void {
		if (this.batchTimer !== null) {
			clearTimeout(this.batchTimer);
			this.batchTimer = null;
		}
		if (this.batchBuffer.length === 0) return;

		const chunks = this.batchBuffer;
		this.batchBuffer = [];
		const appliedCallbacks = this.batchAppliedCallbacks;
		this.batchAppliedCallbacks = [];

		const merged = mergeChunks(chunks);
		this.enqueueOperation(() => this.writeAndNotify(merged, appliedCallbacks));
	}

	private writeAndNotify(
		data: Uint8Array,
		appliedCallbacks: ReadonlyArray<(screen: TerminalScreenSnapshot) => void>,
	): Promise<void> {
		return new Promise<void>((resolve) => {
			this.terminal.write(data, () => {
				if (appliedCallbacks.length > 0) {
					const screen = this.captureVisibleScreen();
					for (const callback of appliedCallbacks) {
						try {
							callback(screen);
						} catch {
							log.warn("terminal applied-output callback failed");
						}
					}
				}
				resolve();
			});
		});
	}

	private captureVisibleScreen(): TerminalScreenSnapshot {
		const buffer = this.terminal.buffer.active;
		const lines: string[] = [];
		for (let row = 0; row < this.terminal.rows; row += 1) {
			lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
		}
		return {
			lines,
			cursorRow: buffer.cursorY,
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
	}

	private enqueueOperation(operation: () => void | Promise<void>): void {
		this.pendingWrite = null;
		this.operationQueue = this.operationQueue
			.catch(() => undefined)
			.then(async () => {
				await operation();
			});
	}
}

function mergeChunks(chunks: readonly Uint8Array[]): Uint8Array {
	if (chunks.length === 1 && chunks[0]) return chunks[0];
	let totalLength = 0;
	for (const chunk of chunks) {
		totalLength += chunk.byteLength;
	}
	const merged = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}
