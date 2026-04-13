import serializeAddonModule from "@xterm/addon-serialize";
import headlessTerminalModule from "@xterm/headless";

const { SerializeAddon } = serializeAddonModule as typeof import("@xterm/addon-serialize");
const { Terminal } = headlessTerminalModule as typeof import("@xterm/headless");

const TERMINAL_SCROLLBACK = 10_000;

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

export interface TerminalRestoreSnapshot {
	snapshot: string;
	cols: number;
	rows: number;
}

interface TerminalStateMirrorOptions {
	onInputResponse?: (data: string) => void;
	/**
	 * Scrollback line count for the mirror terminal and snapshot serialization.
	 * Defaults to {@link TERMINAL_SCROLLBACK} (10,000). The terminal itself
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

	applyOutput(chunk: Buffer): void {
		if (this.disposed) return;
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
		await this.operationQueue;
		if (this.disposed) {
			return null;
		}
		return {
			snapshot: this.serializeAddon.serialize({ scrollback: this.snapshotScrollback }),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
	}

	dispose(): void {
		this.disposed = true;
		this.terminal.dispose();
	}

	private enqueueOperation(operation: () => void | Promise<void>): void {
		this.operationQueue = this.operationQueue
			.catch(() => undefined)
			.then(async () => {
				await operation();
			});
	}
}
