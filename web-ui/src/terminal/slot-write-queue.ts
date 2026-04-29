import type { Terminal } from "@xterm/xterm";

import type { RuntimeTerminalWsClientMessage } from "@/runtime/types";
import type { TerminalWriteOptions } from "@/terminal/terminal-write-options";

interface SlotWriteQueueCallbacks {
	sendControlMessage: (msg: RuntimeTerminalWsClientMessage) => boolean;
	notifyOutputText: (text: string) => void;
	isDisposed: () => boolean;
}

export const SLOT_WRITE_BATCH_MAX_DELAY_MS = 16;
export const SLOT_WRITE_BATCH_MAX_BYTES = 64 * 1024;
export const SLOT_WRITE_BATCH_MAX_CHUNKS = 128;

type SlotWriteDataKind = "string" | "bytes";

interface BasePendingWriteBatch {
	ackBytes: number;
	notifyTextParts: string[];
	byteLength: number;
	resolve: () => void;
	reject: (reason?: unknown) => void;
	promise: Promise<void>;
}

interface PendingStringWriteBatch extends BasePendingWriteBatch {
	kind: "string";
	chunks: string[];
}

interface PendingBytesWriteBatch extends BasePendingWriteBatch {
	kind: "bytes";
	chunks: Uint8Array[];
}

type PendingWriteBatch = PendingStringWriteBatch | PendingBytesWriteBatch;

function getWriteDataKind(data: string | Uint8Array): SlotWriteDataKind {
	return typeof data === "string" ? "string" : "bytes";
}

function getWriteDataLength(data: string | Uint8Array): number {
	return typeof data === "string" ? data.length : data.byteLength;
}

function createPendingWriteBatch(kind: SlotWriteDataKind): PendingWriteBatch {
	let resolveBatch: () => void = () => undefined;
	let rejectBatch: (reason?: unknown) => void = () => undefined;
	const promise = new Promise<void>((resolve, reject) => {
		resolveBatch = resolve;
		rejectBatch = reject;
	});
	const base = {
		ackBytes: 0,
		notifyTextParts: [],
		byteLength: 0,
		resolve: resolveBatch,
		reject: rejectBatch,
		promise,
	};
	if (kind === "string") {
		return { ...base, kind, chunks: [] };
	}
	return { ...base, kind, chunks: [] };
}

function appendToBatch(
	batch: PendingWriteBatch,
	data: string | Uint8Array,
	options: { ackBytes: number; notifyText: string | null },
): void {
	if (batch.kind === "string") {
		if (typeof data !== "string") {
			throw new Error("Cannot append byte output to a string terminal write batch");
		}
		batch.chunks.push(data);
	} else {
		if (typeof data === "string") {
			throw new Error("Cannot append string output to a byte terminal write batch");
		}
		batch.chunks.push(data);
	}
	batch.ackBytes += options.ackBytes;
	batch.byteLength += getWriteDataLength(data);
	if (options.notifyText) {
		batch.notifyTextParts.push(options.notifyText);
	}
}

function combineBatchData(batch: PendingWriteBatch): string | Uint8Array {
	if (batch.kind === "string") {
		return batch.chunks.join("");
	}
	const byteLength = batch.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const result = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of batch.chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export class SlotWriteQueue {
	private queue: Promise<void> = Promise.resolve();
	private pendingBatch: PendingWriteBatch | null = null;
	private batchFrameId: number | null = null;
	private batchTimeoutId: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly terminal: Terminal,
		private readonly callbacks: SlotWriteQueueCallbacks,
	) {}

	enqueue(data: string | Uint8Array, options: TerminalWriteOptions = {}): Promise<void> {
		const ackBytes = options.ackBytes ?? 0;
		const notifyText = options.notifyText ?? null;
		if (options.batch) {
			return this.enqueueBatched(data, { ackBytes, notifyText });
		}
		this.flushPendingBatch();
		return this.enqueueImmediate(data, {
			ackBytes,
			notifyText,
		});
	}

	private enqueueBatched(
		data: string | Uint8Array,
		options: { ackBytes: number; notifyText: string | null },
	): Promise<void> {
		const kind = getWriteDataKind(data);
		if (this.pendingBatch && this.pendingBatch.kind !== kind) {
			this.flushPendingBatch();
		}
		if (!this.pendingBatch) {
			this.pendingBatch = createPendingWriteBatch(kind);
			this.scheduleBatchFlush();
		}
		const batch = this.pendingBatch;
		appendToBatch(batch, data, options);
		if (batch.byteLength >= SLOT_WRITE_BATCH_MAX_BYTES || batch.chunks.length >= SLOT_WRITE_BATCH_MAX_CHUNKS) {
			this.flushPendingBatch();
		}
		return batch.promise;
	}

	private enqueueImmediate(
		data: string | Uint8Array,
		options: {
			ackBytes: number;
			notifyText: string | null;
		},
	): Promise<void> {
		this.queue = this.queue
			.catch(() => undefined)
			.then(
				async () =>
					await new Promise<void>((resolve) => {
						if (this.callbacks.isDisposed()) {
							resolve();
							return;
						}
						this.terminal.write(data, () => {
							if (options.notifyText) {
								this.callbacks.notifyOutputText(options.notifyText);
							}
							if (options.ackBytes > 0) {
								this.callbacks.sendControlMessage({
									type: "output_ack",
									bytes: options.ackBytes,
								});
							}
							resolve();
						});
					}),
			);
		return this.queue;
	}

	private flushPendingBatch(): void {
		if (!this.pendingBatch) {
			return;
		}
		const batch = this.pendingBatch;
		this.pendingBatch = null;
		this.cancelScheduledBatchFlush();
		void this.enqueueImmediate(combineBatchData(batch), {
			ackBytes: batch.ackBytes,
			notifyText: batch.notifyTextParts.join("") || null,
		}).then(batch.resolve, batch.reject);
	}

	private scheduleBatchFlush(): void {
		this.cancelScheduledBatchFlush();
		if (typeof requestAnimationFrame === "function") {
			this.batchFrameId = requestAnimationFrame(() => {
				this.batchFrameId = null;
				this.flushPendingBatch();
			});
		}
		this.batchTimeoutId = setTimeout(() => {
			this.batchTimeoutId = null;
			this.flushPendingBatch();
		}, SLOT_WRITE_BATCH_MAX_DELAY_MS);
	}

	private cancelScheduledBatchFlush(): void {
		if (this.batchFrameId !== null && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(this.batchFrameId);
		}
		this.batchFrameId = null;
		if (this.batchTimeoutId !== null) {
			clearTimeout(this.batchTimeoutId);
		}
		this.batchTimeoutId = null;
	}

	async drain(): Promise<void> {
		this.flushPendingBatch();
		await this.queue.catch(() => undefined);
	}

	chainAction(action: (terminal: Terminal) => void, isDisposed: () => boolean): void {
		this.flushPendingBatch();
		this.queue = this.queue
			.catch(() => undefined)
			.then(() => {
				if (!isDisposed()) {
					action(this.terminal);
				}
			});
	}
}
