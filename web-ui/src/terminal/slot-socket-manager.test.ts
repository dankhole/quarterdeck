import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlotSocketManager } from "@/terminal/slot-socket-manager";
import { TerminalSessionHandle } from "@/terminal/terminal-session-handle";

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly sentMessages: (string | ArrayBufferView)[] = [];
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

	send(data: string | ArrayBufferView): void {
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

function createCallbacks() {
	return {
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
}

function createSessionHandle() {
	const applyRestore = vi.fn(async (_snapshot: string) => {});
	const handle = new TerminalSessionHandle(7, {
		enqueueWrite: vi.fn(),
		applyRestore,
		onSummaryStateChange: vi.fn(),
		onExit: vi.fn(),
		ensureVisible: vi.fn(),
		revealTerminal: vi.fn(async () => true),
		invalidateResize: vi.fn(),
		requestResize: vi.fn(),
		getVisibleContainer: () => null,
		getStageContainer: () => null,
		hasRenderedContent: () => false,
		isDisposed: () => false,
	});
	return { handle, applyRestore };
}

function getSocket(index: number): FakeWebSocket {
	const socket = FakeWebSocket.instances[index];
	if (!socket) throw new Error(`Expected socket ${index}`);
	return socket;
}

async function restoreControl(socket: FakeWebSocket, snapshot: string): Promise<void> {
	socket.emitMessage(JSON.stringify({ type: "restore", snapshot, cols: 80, rows: 24 }));
	await flushMicrotasks();
	await flushMicrotasks();
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
		const callbacks = createCallbacks();
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
		manager.resetConnectionState();
	});

	it("marks live IO writes as batchable with ack and decoded text metadata", () => {
		const callbacks = createCallbacks();
		const manager = new SlotSocketManager(7, "client-1", callbacks);

		manager.connectIo("task-1", "project-1");
		const ioSocket = FakeWebSocket.instances[0];
		if (!ioSocket) {
			throw new Error("Expected IO socket");
		}
		ioSocket.emitMessage("hello");

		expect(callbacks.enqueueWrite).toHaveBeenCalledWith("hello", {
			ackBytes: 5,
			notifyText: "hello",
			batch: true,
		});
	});

	it("copies binary IO writes into a WebSocket-compatible buffer", () => {
		const manager = new SlotSocketManager(7, "client-1", createCallbacks());

		manager.connectIo("task-1", "project-1");
		const ioSocket = FakeWebSocket.instances[0];
		if (!ioSocket) {
			throw new Error("Expected IO socket");
		}
		ioSocket.open();

		const payload = new Uint8Array([1, 2, 3]);
		expect(manager.sendIo(payload)).toBe(true);

		const sentPayload = ioSocket.sentMessages[0];
		expect(sentPayload).toBeInstanceOf(Uint8Array);
		expect(Array.from(sentPayload as Uint8Array)).toEqual([1, 2, 3]);
		expect(sentPayload).not.toBe(payload);
	});

	it.each(["ensureConnected", "requestRestore"] as const)(
		"%s replaces both peers and completes restore after IO closes with control still open",
		async (recovery) => {
			const { handle, applyRestore } = createSessionHandle();
			handle.connectToTask("task-1", "project-1");
			const oldIo = getSocket(0);
			const oldControl = getSocket(1);
			oldIo.open();
			oldControl.open();
			await restoreControl(oldControl, "old snapshot");
			expect(handle.restoreCompleted).toBe(true);

			oldIo.close();
			expect(oldControl.readyState).toBe(FakeWebSocket.OPEN);
			expect(handle.restoreCompleted).toBe(false);
			handle[recovery]();

			expect(oldControl.readyState).toBe(FakeWebSocket.CLOSED);
			const replacementIo = getSocket(2);
			const replacementControl = getSocket(3);
			replacementIo.open();
			replacementControl.open();
			await restoreControl(replacementControl, "resumed snapshot");

			expect(applyRestore).toHaveBeenLastCalledWith("resumed snapshot", 80, 24);
			expect(handle.restoreCompleted).toBe(true);
			expect(replacementControl.sentMessages).toEqual([JSON.stringify({ type: "restore_complete" })]);
			expect(handle.sendIo("hello\r")).toBe(true);
			expect(replacementIo.sentMessages).toEqual(["hello\r"]);
			handle.requestRestore();
			expect(replacementControl.sentMessages.at(-1)).toBe(JSON.stringify({ type: "request_restore" }));
			handle.dispose();
		},
	);

	it("queues an explicit re-sync behind the healthy initial restore", async () => {
		const { handle } = createSessionHandle();
		handle.connectToTask("task-1", "project-1");
		getSocket(0).open();
		const control = getSocket(1);
		control.open();
		handle.requestRestore();
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(control.sentMessages).toEqual([]);

		await restoreControl(control, "initial snapshot");
		expect(control.sentMessages).toEqual([
			JSON.stringify({ type: "restore_complete" }),
			JSON.stringify({ type: "request_restore" }),
		]);
		expect(handle.restoreCompleted).toBe(false);
		await restoreControl(control, "requested snapshot");
		expect(handle.restoreCompleted).toBe(true);
		handle.dispose();
	});

	it.each([0, 1])("replaces the pair while socket %s is closing before its close event", (closingPeer) => {
		const { handle } = createSessionHandle();
		handle.connectToTask("task-1", "project-1");
		const oldIo = getSocket(0);
		const oldControl = getSocket(1);
		getSocket(closingPeer).readyState = FakeWebSocket.CLOSING;

		handle.ensureConnected();
		expect(FakeWebSocket.instances).toHaveLength(4);
		expect(oldIo.readyState).toBe(FakeWebSocket.CLOSED);
		expect(oldControl.readyState).toBe(FakeWebSocket.CLOSED);
		expect(handle.hasIoSocket).toBe(true);
		expect(handle.hasControlSocket).toBe(true);
		handle.dispose();
	});

	it("preserves an initial connecting socket pair on repeated acquire", () => {
		const { handle } = createSessionHandle();
		handle.connectToTask("task-1", "project-1");
		handle.ensureConnected();
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(getSocket(0).readyState).toBe(FakeWebSocket.CONNECTING);
		expect(getSocket(1).readyState).toBe(FakeWebSocket.CONNECTING);
		handle.dispose();
	});

	it("ignores messages and close events from a replaced socket pair", () => {
		const callbacks = createCallbacks();
		const manager = new SlotSocketManager(7, "client-1", callbacks);
		manager.connectIo("task-1", "project-1");
		manager.connectControl("task-1", "project-1");
		const oldIo = getSocket(0);
		const oldControl = getSocket(1);
		manager.closeAll();
		manager.resetConnectionState();
		manager.connectIo("task-1", "project-1");
		manager.connectControl("task-1", "project-1");

		oldIo.emitMessage("obsolete output");
		oldControl.emitMessage(JSON.stringify({ type: "restore", snapshot: "obsolete snapshot" }));
		oldControl.emitMessage(JSON.stringify({ type: "state", summary: {} }));
		oldControl.emitMessage(JSON.stringify({ type: "exit", code: 0 }));
		oldIo.close();
		oldControl.close();

		expect(callbacks.enqueueWrite).not.toHaveBeenCalled();
		expect(callbacks.onRestore).not.toHaveBeenCalled();
		expect(callbacks.onState).not.toHaveBeenCalled();
		expect(callbacks.onExit).not.toHaveBeenCalled();
		expect(callbacks.onLastError).not.toHaveBeenCalled();
		expect(manager.hasIoSocket).toBe(true);
		expect(manager.hasControlSocket).toBe(true);
		manager.closeAll();
	});

	it("does not acknowledge an obsolete in-flight restore on replacement control", async () => {
		const callbacks = createCallbacks();
		let completeRestore: () => void = () => {};
		callbacks.onRestore.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					completeRestore = resolve;
				}),
		);
		const manager = new SlotSocketManager(7, "client-1", callbacks);
		manager.connectControl("task-1", "project-1");
		const oldControl = getSocket(0);
		oldControl.open();
		oldControl.emitMessage(JSON.stringify({ type: "restore", snapshot: "obsolete snapshot" }));
		manager.closeAll();
		manager.resetConnectionState();
		manager.connectControl("task-1", "project-1");
		const replacementControl = getSocket(1);
		replacementControl.open();
		completeRestore();
		await flushMicrotasks();

		expect(manager.restoreCompleted).toBe(false);
		expect(replacementControl.sentMessages).toEqual([]);
		manager.closeAll();
	});
});
