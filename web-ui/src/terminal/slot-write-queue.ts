import type { Terminal } from "@xterm/xterm";

import type { RuntimeTerminalWsClientMessage } from "@/runtime/types";
import type { TerminalWriteDiagnostics } from "@/terminal/terminal-write-diagnostics";

interface SlotWriteQueueCallbacks {
	sendControlMessage: (msg: RuntimeTerminalWsClientMessage) => boolean;
	notifyOutputText: (text: string) => void;
	getDiagnostics: () => TerminalWriteDiagnostics;
	isDisposed: () => boolean;
}

// [perf-investigation] Track how many terminal.write() calls happen per window
// across all slots and which hidden/visible slot is doing the writing. If the
// scrollbar is visibly changing on an "idle" agent, this tells us whether xterm
// is actually being written to (agent streaming cursor/status lines) vs. the
// problem being a redraw-without-data issue. Uses console.info instead of
// console.warn/client logging so it bypasses the debug panel's warn/error
// capture. Remove this block and the reportTerminalWrite() call when the
// investigation is complete.
const WRITE_REPORT_INTERVAL_MS = 5000;
let writeCountWindow = 0;
let writeBytesWindow = 0;
let writeWindowStart = Date.now();

interface TerminalWriteWindowEntry {
	diagnostics: TerminalWriteDiagnostics;
	writes: number;
	bytes: number;
}

const writeWindowBySlotTask = new Map<string, TerminalWriteWindowEntry>();

function roundRate(value: number): number {
	return Math.round(value * 10) / 10;
}

function getWriteWindowKey(diagnostics: TerminalWriteDiagnostics): string {
	return `${diagnostics.slotId}:${diagnostics.taskId ?? "(none)"}`;
}

function reportTerminalWrite(byteLength: number, diagnostics: TerminalWriteDiagnostics): void {
	writeCountWindow += 1;
	writeBytesWindow += byteLength;
	const entry = writeWindowBySlotTask.get(getWriteWindowKey(diagnostics));
	if (entry) {
		entry.diagnostics = diagnostics;
		entry.writes += 1;
		entry.bytes += byteLength;
	} else {
		writeWindowBySlotTask.set(getWriteWindowKey(diagnostics), {
			diagnostics,
			writes: 1,
			bytes: byteLength,
		});
	}
	const now = Date.now();
	const elapsed = now - writeWindowStart;
	if (elapsed >= WRITE_REPORT_INTERVAL_MS) {
		const writers = [...writeWindowBySlotTask.values()]
			.sort((left, right) => right.writes - left.writes)
			.map((writer) => ({
				slotId: writer.diagnostics.slotId,
				taskId: writer.diagnostics.taskId,
				poolRole: writer.diagnostics.poolRole,
				visibility: writer.diagnostics.visibility,
				ioSocketState: writer.diagnostics.ioSocketState,
				controlSocketState: writer.diagnostics.controlSocketState,
				connectionReady: writer.diagnostics.connectionReady,
				restoreCompleted: writer.diagnostics.restoreCompleted,
				writesInWindow: writer.writes,
				bytesInWindow: writer.bytes,
				writesPerSec: roundRate((writer.writes / elapsed) * 1000),
				bytesPerSec: Math.round((writer.bytes / elapsed) * 1000),
			}));
		const activeWritingSlotIds = new Set(writers.map((writer) => writer.slotId));
		const activeHiddenWritingSlotIds = new Set(
			writers.filter((writer) => writer.visibility !== "visible").map((writer) => writer.slotId),
		);
		console.info("[perf-investigation] xterm write rate", {
			activeWritingTerminals: activeWritingSlotIds.size,
			activeHiddenWritingTerminals: activeHiddenWritingSlotIds.size,
			activeWritingSlotTaskStreams: writers.length,
			writesInWindow: writeCountWindow,
			bytesInWindow: writeBytesWindow,
			windowMs: elapsed,
			writesPerSec: roundRate((writeCountWindow / elapsed) * 1000),
			bytesPerSec: Math.round((writeBytesWindow / elapsed) * 1000),
			writers,
		});
		writeCountWindow = 0;
		writeBytesWindow = 0;
		writeWindowStart = now;
		writeWindowBySlotTask.clear();
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
						reportTerminalWrite(
							typeof data === "string" ? data.length : data.byteLength,
							this.callbacks.getDiagnostics(),
						);
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
