import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { socketInstances, SlotSocketManagerMock } = vi.hoisted(() => {
	interface MockSlotSocketCallbacks {
		onIoOpen: () => void;
	}

	class MockSlotSocketManager {
		hasIoSocket = false;
		hasControlSocket = false;
		isIoOpen = false;
		connectionReady = false;
		restoreCompleted = false;
		connectIo = vi.fn(() => {
			this.hasIoSocket = true;
		});
		connectControl = vi.fn(() => {
			this.hasControlSocket = true;
		});
		requestRestore = vi.fn(() => true);
		closeAll = vi.fn();
		resetConnectionState = vi.fn();
		sendIo = vi.fn(() => true);
		sendControl = vi.fn(() => true);
		openIo = vi.fn(() => {
			this.isIoOpen = true;
			this.callbacks.onIoOpen();
		});

		constructor(
			_slotId: number,
			_clientId: string,
			private readonly callbacks: MockSlotSocketCallbacks,
		) {
			instances.push(this);
		}
	}
	const instances: MockSlotSocketManager[] = [];
	return { socketInstances: instances, SlotSocketManagerMock: MockSlotSocketManager };
});

vi.mock("@/terminal/slot-socket-manager", () => ({
	SlotSocketManager: SlotSocketManagerMock,
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: vi.fn(),
}));

vi.mock("@/utils/client-logger", () => ({
	createClientLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import { TerminalSessionHandle } from "@/terminal/terminal-session-handle";

function createDeferred<T>() {
	let resolve: (value?: T | PromiseLike<T>) => void = () => {};
	let reject: (reason?: unknown) => void = () => {};
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = (value) => promiseResolve(value as T | PromiseLike<T>);
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createHandle(callbacks?: {
	ensureVisible?: () => void;
	revealTerminal?: () => Promise<boolean>;
	onConnectionReady?: (taskId: string) => void;
}) {
	const ensureVisible: () => void = callbacks?.ensureVisible ?? vi.fn();
	const revealTerminal: () => Promise<boolean> = callbacks?.revealTerminal ?? vi.fn(async () => true);
	const handle = new TerminalSessionHandle(1, {
		enqueueWrite: vi.fn(),
		applyRestore: vi.fn(async () => {}),
		onSummaryStateChange: vi.fn(),
		onExit: vi.fn(),
		ensureVisible,
		revealTerminal,
		invalidateResize: vi.fn(),
		requestResize: vi.fn(),
		getVisibleContainer: vi.fn(() => document.createElement("div")),
		getStageContainer: vi.fn(() => document.createElement("div")),
		isDisposed: vi.fn(() => false),
	});
	if (callbacks?.onConnectionReady) {
		handle.subscribe({ onConnectionReady: callbacks.onConnectionReady });
	}
	return { handle, ensureVisible, revealTerminal };
}

describe("TerminalSessionHandle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		socketInstances.length = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("makes the terminal interactive without requesting restore if restore readiness stalls but IO is open", async () => {
		const onConnectionReady = vi.fn();
		const { handle, ensureVisible, revealTerminal } = createHandle({ onConnectionReady });

		handle.connectToTask("task-1", "project-1");
		const sockets = socketInstances[0];
		expect(sockets).toBeDefined();
		if (!sockets) {
			return;
		}
		sockets.isIoOpen = true;

		await vi.advanceTimersByTimeAsync(1500);

		expect(ensureVisible).not.toHaveBeenCalled();
		expect(revealTerminal).toHaveBeenCalledOnce();
		expect(sockets.requestRestore).not.toHaveBeenCalled();
		expect(sockets.connectionReady).toBe(true);
		expect(onConnectionReady).toHaveBeenCalledWith("task-1");
	});

	it("keeps waiting if restore readiness stalls before IO opens", async () => {
		const onConnectionReady = vi.fn();
		const { handle, ensureVisible, revealTerminal } = createHandle({ onConnectionReady });

		handle.connectToTask("task-1", "project-1");
		const sockets = socketInstances[0];
		expect(sockets).toBeDefined();
		if (!sockets) {
			return;
		}
		sockets.isIoOpen = false;

		await vi.advanceTimersByTimeAsync(1500);

		expect(ensureVisible).not.toHaveBeenCalled();
		expect(revealTerminal).not.toHaveBeenCalled();
		expect(sockets.requestRestore).not.toHaveBeenCalled();
		expect(sockets.connectionReady).toBe(false);
		expect(onConnectionReady).not.toHaveBeenCalled();
	});

	it("makes the terminal interactive after a delayed IO open", async () => {
		const onConnectionReady = vi.fn();
		const { handle, ensureVisible, revealTerminal } = createHandle({ onConnectionReady });

		handle.connectToTask("task-1", "project-1");
		const sockets = socketInstances[0];
		expect(sockets).toBeDefined();
		if (!sockets) {
			return;
		}

		await vi.advanceTimersByTimeAsync(1500);
		expect(onConnectionReady).not.toHaveBeenCalled();

		sockets.openIo();
		await vi.advanceTimersByTimeAsync(1500);

		expect(ensureVisible).not.toHaveBeenCalled();
		expect(revealTerminal).toHaveBeenCalledOnce();
		expect(sockets.requestRestore).not.toHaveBeenCalled();
		expect(sockets.connectionReady).toBe(true);
		expect(onConnectionReady).toHaveBeenCalledWith("task-1");
	});

	it("arms the readiness fallback when reconnecting an existing task", async () => {
		const onConnectionReady = vi.fn();
		const { handle, ensureVisible, revealTerminal } = createHandle({ onConnectionReady });

		handle.connectToTask("task-1", "project-1");
		const sockets = socketInstances[0];
		expect(sockets).toBeDefined();
		if (!sockets) {
			return;
		}
		sockets.isIoOpen = true;

		handle.connectToTask("task-1", "project-1");
		await vi.advanceTimersByTimeAsync(1500);

		expect(ensureVisible).not.toHaveBeenCalled();
		expect(revealTerminal).toHaveBeenCalledOnce();
		expect(sockets.requestRestore).not.toHaveBeenCalled();
		expect(sockets.connectionReady).toBe(true);
		expect(onConnectionReady).toHaveBeenCalledWith("task-1");
	});

	it("waits for fallback presentation before reporting the terminal connection ready", async () => {
		const onConnectionReady = vi.fn();
		const reveal = createDeferred<boolean>();
		const revealTerminal = vi.fn(() => reveal.promise);
		const { handle } = createHandle({ onConnectionReady, revealTerminal });

		handle.connectToTask("task-1", "project-1");
		const sockets = socketInstances[0];
		expect(sockets).toBeDefined();
		if (!sockets) {
			return;
		}
		sockets.isIoOpen = true;

		await vi.advanceTimersByTimeAsync(1500);

		expect(revealTerminal).toHaveBeenCalledOnce();
		expect(sockets.connectionReady).toBe(false);
		expect(onConnectionReady).not.toHaveBeenCalled();

		reveal.resolve(true);
		await reveal.promise;
		await flushMicrotasks();

		expect(sockets.connectionReady).toBe(true);
		expect(onConnectionReady).toHaveBeenCalledWith("task-1");
	});

	it("does not report fallback readiness when presentation is superseded by a restore reveal", async () => {
		const onConnectionReady = vi.fn();
		const reveal = createDeferred<boolean>();
		const revealTerminal = vi.fn(() => reveal.promise);
		const { handle } = createHandle({ onConnectionReady, revealTerminal });

		handle.connectToTask("task-1", "project-1");
		const sockets = socketInstances[0];
		expect(sockets).toBeDefined();
		if (!sockets) {
			return;
		}
		sockets.isIoOpen = true;

		await vi.advanceTimersByTimeAsync(1500);
		reveal.resolve(false);
		await reveal.promise;
		await flushMicrotasks();

		expect(sockets.connectionReady).toBe(false);
		expect(onConnectionReady).not.toHaveBeenCalled();
	});

	it("drops stale sockets and reconnects when the task session instance changes", async () => {
		const { handle } = createHandle();

		handle.connectToTask("task-1", "project-1");
		const sockets = socketInstances[0];
		expect(sockets).toBeDefined();
		if (!sockets) {
			return;
		}
		sockets.hasIoSocket = true;
		sockets.hasControlSocket = true;
		sockets.isIoOpen = true;
		sockets.restoreCompleted = false;
		sockets.connectIo.mockClear();
		sockets.connectControl.mockClear();

		handle.reconnect("session_instance_changed");

		expect(sockets.closeAll).toHaveBeenCalledOnce();
		expect(sockets.resetConnectionState).toHaveBeenCalledOnce();
		expect(sockets.connectIo).toHaveBeenCalledWith("task-1", "project-1");
		expect(sockets.connectControl).toHaveBeenCalledWith("task-1", "project-1");
	});
});
