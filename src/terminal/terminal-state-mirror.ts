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
}

export class TerminalStateMirror {
	private readonly terminal: InstanceType<typeof Terminal>;
	private readonly serializeAddon = new SerializeAddon();
	private operationQueue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(cols: number, rows: number, options: TerminalStateMirrorOptions = {}) {
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols,
			rows,
			scrollback: TERMINAL_SCROLLBACK,
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

	// When targetCols/targetRows are provided, the mirror is resized before serializing so the
	// headless xterm instance reflows content to the caller's dimensions. This resize is permanent —
	// until the browser sends a follow-up resize message (which arrives right after restore_complete),
	// the mirror and PTY dimensions are briefly out of sync. Any agent output during that window is
	// captured at the new mirror width while the PTY still reports the old $COLUMNS. In practice this
	// gap is milliseconds and identical to the transient mismatch during any normal resize.
	async getSnapshot(targetCols?: number, targetRows?: number): Promise<TerminalRestoreSnapshot | null> {
		if (this.disposed) {
			return null;
		}
		if (targetCols && targetRows && (targetCols !== this.terminal.cols || targetRows !== this.terminal.rows)) {
			this.enqueueOperation(() => {
				this.terminal.resize(targetCols, targetRows);
			});
		}
		await this.operationQueue;
		if (this.disposed) {
			return null;
		}
		return {
			snapshot: this.serializeAddon.serialize(),
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
