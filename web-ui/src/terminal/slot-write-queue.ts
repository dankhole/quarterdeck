import type { Terminal } from "@xterm/xterm";

import type { RuntimeTerminalWsClientMessage } from "@/runtime/types";

interface SlotWriteQueueCallbacks {
	sendControlMessage: (msg: RuntimeTerminalWsClientMessage) => boolean;
	notifyOutputText: (text: string) => void;
	isDisposed: () => boolean;
}

// [perf-investigation] Track how many terminal.write() calls happen per window
// across all slots. If the scrollbar is visibly changing on an "idle" agent,
// this tells us whether xterm is actually being written to (agent streaming
// cursor/status lines) vs. the problem being a redraw-without-data issue.
// Uses console.info instead of console.warn/client logging so it bypasses the
// debug panel's warn/error capture. Remove this block and the
// reportTerminalWrite() call if writes aren't the cause.
const WRITE_REPORT_INTERVAL_MS = 5000;
let writeCountWindow = 0;
let writeBytesWindow = 0;
let writeWindowStart = Date.now();
function reportTerminalWrite(byteLength: number): void {
	writeCountWindow += 1;
	writeBytesWindow += byteLength;
	const now = Date.now();
	const elapsed = now - writeWindowStart;
	if (elapsed >= WRITE_REPORT_INTERVAL_MS) {
		console.info("[perf-investigation] xterm write rate", {
			writesInWindow: writeCountWindow,
			bytesInWindow: writeBytesWindow,
			windowMs: elapsed,
			writesPerSec: Math.round((writeCountWindow / elapsed) * 1000 * 10) / 10,
			bytesPerSec: Math.round((writeBytesWindow / elapsed) * 1000),
		});
		writeCountWindow = 0;
		writeBytesWindow = 0;
		writeWindowStart = now;
	}
}

export class SlotWriteQueue {
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly terminal: Terminal,
		private readonly callbacks: SlotWriteQueueCallbacks,
	) {}

	enqueue(
		data: string | Uint8Array,
		options: {
			ackBytes?: number;
			notifyText?: string | null;
		} = {},
	): Promise<void> {
		const ackBytes = options.ackBytes ?? 0;
		const notifyText = options.notifyText ?? null;
		this.queue = this.queue
			.catch(() => undefined)
			.then(
				async () =>
					await new Promise<void>((resolve) => {
						if (this.callbacks.isDisposed()) {
							resolve();
							return;
						}
						reportTerminalWrite(typeof data === "string" ? data.length : data.byteLength);
						this.terminal.write(data, () => {
							if (notifyText) {
								this.callbacks.notifyOutputText(notifyText);
							}
							if (ackBytes > 0) {
								this.callbacks.sendControlMessage({
									type: "output_ack",
									bytes: ackBytes,
								});
							}
							resolve();
						});
					}),
			);
		return this.queue;
	}

	drain(): Promise<void> {
		return this.queue.catch(() => undefined);
	}

	chainAction(action: (terminal: Terminal) => void, isDisposed: () => boolean): void {
		this.queue = this.queue
			.catch(() => undefined)
			.then(() => {
				if (!isDisposed()) {
					action(this.terminal);
				}
			});
	}
}
