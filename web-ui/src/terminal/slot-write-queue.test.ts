import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SLOT_WRITE_BATCH_MAX_BYTES, SLOT_WRITE_BATCH_MAX_DELAY_MS, SlotWriteQueue } from "@/terminal/slot-write-queue";

type TerminalWriteData = string | Uint8Array;

interface QueueHarness {
	queue: SlotWriteQueue;
	writes: TerminalWriteData[];
	sendControlMessage: ReturnType<typeof vi.fn>;
	notifyOutputText: ReturnType<typeof vi.fn>;
	isDisposed: ReturnType<typeof vi.fn>;
}

function createHarness(): QueueHarness {
	const writes: TerminalWriteData[] = [];
	const terminal = {
		write: vi.fn((data: TerminalWriteData, callback?: () => void) => {
			writes.push(data);
			callback?.();
		}),
	} satisfies Pick<Terminal, "write">;
	const sendControlMessage = vi.fn(() => true);
	const notifyOutputText = vi.fn();
	const isDisposed = vi.fn(() => false);
	const queue = new SlotWriteQueue(terminal as unknown as Terminal, {
		sendControlMessage,
		notifyOutputText,
		isDisposed,
	});
	return { queue, writes, sendControlMessage, notifyOutputText, isDisposed };
}

function installManualAnimationFrame(): {
	flushNextFrame: () => void;
	restore: () => void;
} {
	const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
	const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
	const callbacks = new Map<number, FrameRequestCallback>();
	let nextId = 1;

	Object.defineProperty(globalThis, "requestAnimationFrame", {
		configurable: true,
		writable: true,
		value: (callback: FrameRequestCallback) => {
			const id = nextId;
			nextId += 1;
			callbacks.set(id, callback);
			return id;
		},
	});
	Object.defineProperty(globalThis, "cancelAnimationFrame", {
		configurable: true,
		writable: true,
		value: (id: number) => {
			callbacks.delete(id);
		},
	});

	return {
		flushNextFrame: () => {
			const next = callbacks.entries().next();
			if (next.done) {
				throw new Error("Expected a queued animation frame");
			}
			const [id, callback] = next.value;
			callbacks.delete(id);
			callback(performance.now());
		},
		restore: () => {
			Object.defineProperty(globalThis, "requestAnimationFrame", {
				configurable: true,
				writable: true,
				value: originalRequestAnimationFrame,
			});
			Object.defineProperty(globalThis, "cancelAnimationFrame", {
				configurable: true,
				writable: true,
				value: originalCancelAnimationFrame,
			});
		},
	};
}

describe("SlotWriteQueue", () => {
	let animationFrame: ReturnType<typeof installManualAnimationFrame>;

	beforeEach(() => {
		vi.useFakeTimers();
		animationFrame = installManualAnimationFrame();
	});

	afterEach(() => {
		animationFrame.restore();
		vi.useRealTimers();
	});

	it("coalesces consecutive live string chunks until the next animation frame", async () => {
		const { queue, writes, sendControlMessage, notifyOutputText } = createHarness();

		const first = queue.enqueue("hel", { ackBytes: 3, notifyText: "hel", batch: true });
		const second = queue.enqueue("lo", { ackBytes: 2, notifyText: "lo", batch: true });

		expect(writes).toEqual([]);

		animationFrame.flushNextFrame();
		await first;
		await second;

		expect(writes).toEqual(["hello"]);
		expect(sendControlMessage).toHaveBeenCalledOnce();
		expect(sendControlMessage).toHaveBeenCalledWith({ type: "output_ack", bytes: 5 });
		expect(notifyOutputText).toHaveBeenCalledOnce();
		expect(notifyOutputText).toHaveBeenCalledWith("hello");
	});

	it("coalesces consecutive live byte chunks in order", async () => {
		const { queue, writes, sendControlMessage, notifyOutputText } = createHarness();

		const first = queue.enqueue(new Uint8Array([1, 2]), { ackBytes: 2, notifyText: "a", batch: true });
		const second = queue.enqueue(new Uint8Array([3]), { ackBytes: 1, notifyText: "b", batch: true });

		animationFrame.flushNextFrame();
		await first;
		await second;

		expect(writes).toEqual([new Uint8Array([1, 2, 3])]);
		expect(sendControlMessage).toHaveBeenCalledWith({ type: "output_ack", bytes: 3 });
		expect(notifyOutputText).toHaveBeenCalledWith("ab");
	});

	it("flushes a pending batch before an immediate write", async () => {
		const { queue, writes } = createHarness();

		const batched = queue.enqueue("live", { batch: true });
		const immediate = queue.enqueue("status");
		await batched;
		await immediate;

		expect(writes).toEqual(["live", "status"]);
	});

	it("flushes a pending batch before drain resolves", async () => {
		const { queue, writes } = createHarness();

		const batched = queue.enqueue("live", { batch: true });
		await queue.drain();
		await batched;

		expect(writes).toEqual(["live"]);
	});

	it("flushes promptly with the timeout fallback", async () => {
		animationFrame.restore();
		Object.defineProperty(globalThis, "requestAnimationFrame", {
			configurable: true,
			writable: true,
			value: undefined,
		});
		const { queue, writes } = createHarness();

		const batched = queue.enqueue("prompt", { batch: true });
		await vi.advanceTimersByTimeAsync(SLOT_WRITE_BATCH_MAX_DELAY_MS);
		await batched;

		expect(writes).toEqual(["prompt"]);
	});

	it("flushes immediately when the batch reaches the byte cap", async () => {
		const { queue, writes } = createHarness();
		const chunk = new Uint8Array(SLOT_WRITE_BATCH_MAX_BYTES);

		const batched = queue.enqueue(chunk, { ackBytes: chunk.byteLength, batch: true });
		await batched;

		expect(writes).toEqual([chunk]);
	});
});
