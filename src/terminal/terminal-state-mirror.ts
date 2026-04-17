import serializeAddonModule from "@xterm/addon-serialize";
import headlessTerminalModule from "@xterm/headless";

import { createTaggedLogger } from "../core";

const log = createTaggedLogger("terminal-mirror");

const { SerializeAddon } = serializeAddonModule as typeof import("@xterm/addon-serialize");
const { Terminal } = headlessTerminalModule as typeof import("@xterm/headless");

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

	private readonly snapshotScrollback: number;

	private batching = false;
	private batchBuffer: Uint8Array[] = [];
	private batchTimer: ReturnType<typeof setTimeout> | null = null;

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

	applyOutput(chunk: Buffer): void {
		if (this.disposed) return;

		if (this.batching) {
			this.batchBuffer.push(new Uint8Array(chunk));
			if (this.batchTimer === null) {
				this.batchTimer = setTimeout(() => this.flushBatch(), BATCH_FLUSH_INTERVAL_MS);
			}
			return;
		}

		const chunkCopy = new Uint8Array(chunk);
		this.enqueueOperation(
			() =>
				new Promise<void>((resolve) => {
					this.terminal.write(chunkCopy, () => {
						resolve();
					});
				}),
		);
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
		const snapshot = this.serializeAddon.serialize({ scrollback: this.snapshotScrollback });
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

	dispose(): void {
		this.disposed = true;
		if (this.batchTimer !== null) {
			clearTimeout(this.batchTimer);
			this.batchTimer = null;
		}
		this.batchBuffer.length = 0;
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

		this.enqueueOperation(
			() =>
				new Promise<void>((resolve) => {
					this.terminal.write(merged, () => {
						resolve();
					});
				}),
		);
	}

	private enqueueOperation(operation: () => void | Promise<void>): void {
		this.operationQueue = this.operationQueue
			.catch(() => undefined)
			.then(async () => {
				await operation();
			});
	}
}
