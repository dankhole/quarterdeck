import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlotSocketManager } from "@/terminal/slot-socket-manager";

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly sentMessages: string[] = [];
	readyState = FakeWebSocket.CONNECTING;
	binaryType = "";
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: (event?: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? new Set<(event?: unknown) => void>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	send(data: string): void {
		this.sentMessages.push(data);
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
		this.emit("close");
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
		this.emit("open");
	}

	emitMessage(data: string): void {
		const event = { data };
		this.onmessage?.(event);
		this.emit("message", event);
	}

	private emit(type: string, event?: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => queueMicrotask(resolve));
}

describe("SlotSocketManager", () => {
	const originalWebSocket = globalThis.WebSocket;

	beforeEach(() => {
		FakeWebSocket.instances = [];
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			writable: true,
			value: FakeWebSocket,
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			writable: true,
			value: originalWebSocket,
		});
	});

	it("replays a queued restore request after the initial restore completes", async () => {
		const callbacks = {
			enqueueWrite: vi.fn(),
			onRestore: vi.fn(async () => {}),
			onState: vi.fn(),
			onExit: vi.fn(),
			onError: vi.fn(),
			onIoOpen: vi.fn(),
			onConnectionReady: vi.fn(),
			onLastError: vi.fn(),
			ensureVisible: vi.fn(),
			invalidateResize: vi.fn(),
			requestResize: vi.fn(),
			getVisibleContainer: vi.fn(() => document.createElement("div")),
			getStageContainer: vi.fn(() => document.createElement("div")),
			isDisposed: vi.fn(() => false),
		};
		const manager = new SlotSocketManager(7, "client-1", callbacks);

		manager.connectControl("task-1", "project-1");
		const controlSocket = FakeWebSocket.instances[0];
		if (!controlSocket) {
			throw new Error("Expected control socket");
		}
		controlSocket.open();

		expect(manager.requestRestore()).toBe(true);
		expect(controlSocket.sentMessages).toEqual([]);

		controlSocket.emitMessage(JSON.stringify({ type: "restore", snapshot: "", cols: null, rows: null }));
		await flushMicrotasks();

		expect(callbacks.onRestore).toHaveBeenCalledOnce();
		expect(controlSocket.sentMessages).toEqual([
			JSON.stringify({ type: "restore_complete" }),
			JSON.stringify({ type: "request_restore" }),
		]);
		expect(manager.restoreCompleted).toBe(false);
	});
});
