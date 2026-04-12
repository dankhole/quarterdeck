import serializeAddonModule from "@xterm/addon-serialize";
import headlessTerminalModule from "@xterm/headless";

const { SerializeAddon } = serializeAddonModule as typeof import("@xterm/addon-serialize");
const { Terminal } = headlessTerminalModule as typeof import("@xterm/headless");

const TERMINAL_SCROLLBACK = 10_000;

export interface TerminalRestoreSnapshot {
	snapshot: string;
	cols: number;
	rows: number;
}

interface TerminalStateMirrorOptions {
	onInputResponse?: (data: string) => void;
	scrollOnEraseInDisplay?: boolean;
	/**
	 * Set to 0 for TUI agent sessions. The mirror only needs the viewport —
	 * TUI agents manage their own scrolling internally and any mirror-side
	 * scrollback just bloats restore snapshots with duplicate content.
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
			scrollback,
			scrollOnEraseInDisplay: options.scrollOnEraseInDisplay ?? true,
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
