import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

const { socketInstances, SlotSocketManagerMock } = vi.hoisted(() => {
	interface MockSlotSocketCallbacks {
		onIoOpen: () => void;
		onState: (payload: { type: "state"; summary: RuntimeTaskSessionSummary }) => void;
		onRestore: (snapshot: string, cols: number, rows: number) => Promise<void>;
		onExit: (code: number | null) => void;
		onLastError: (message: string | null) => void;
	}

	class MockSlotSocketManager {
		hasIoSocket = false;
		hasControlSocket = false;
		isIoOpen = false;
		connectionReady = false;
		restoreCompleted = false;
		get requiresReconnect(): boolean {
			return !this.hasIoSocket || !this.hasControlSocket;
		}
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
		emitState = (summary: RuntimeTaskSessionSummary) => this.callbacks.onState({ type: "state", summary });
		emitRestore = (snapshot: string) => this.callbacks.onRestore(snapshot, 80, 24);
		emitExit = () => this.callbacks.onExit(0);
		emitError = () => this.callbacks.onLastError("Terminal stream failed.");
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

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { TerminalSessionHandle } from "@/terminal/terminal-session-handle";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";

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
	hasRenderedContent?: () => boolean;
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
		hasRenderedContent: callbacks?.hasRenderedContent ?? (() => false),
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

	it("keeps an empty agent restore pending while input is ready, then clears after rendered content", async () => {
		let hasContent = false;
		const { handle } = createHandle({ hasRenderedContent: () => hasContent });
		const onContentPending = vi.fn();
		handle.connectToTask("task-1", "project-1");
		handle.subscribe({ onContentPending });
		const sockets = socketInstances[0]!;
		sockets.emitState(createTestTaskSessionSummary({ agentId: "claude", pid: 111, startedAt: 100 }));
		await sockets.emitRestore("");
		sockets.openIo();
		await vi.advanceTimersByTimeAsync(1500);
		expect(sockets.connectionReady).toBe(true);
		expect(onContentPending.mock.calls.map(([pending]) => pending)).toEqual([false, true]);
		const replay = vi.fn();
		handle.subscribe({ onContentPending: replay });
		expect(replay).toHaveBeenLastCalledWith(true);
		handle.publishOutputText("\x1b[2J");
		expect(onContentPending).toHaveBeenLastCalledWith(true);
		hasContent = true;
		handle.publishOutputText("Agent prompt");
		expect(onContentPending).toHaveBeenLastCalledWith(false);
	});

	it("resolves content pending after a rendered restore and resets for a blank replacement", async () => {
		let hasContent = false;
		const { handle } = createHandle({ hasRenderedContent: () => hasContent });
		handle.connectToTask("task-1", "project-1");
		const pending = vi.fn();
		handle.subscribe({ onContentPending: pending });
		const sockets = socketInstances[0]!;
		sockets.emitState(createTestTaskSessionSummary({ agentId: "claude", pid: 111, startedAt: 100 }));
		hasContent = true;
		await sockets.emitRestore("Restored prompt");
		expect(pending).toHaveBeenLastCalledWith(false);
		hasContent = false;
		sockets.emitState(createTestTaskSessionSummary({ agentId: "claude", pid: 222, startedAt: 200 }));
		expect(pending).toHaveBeenLastCalledWith(true);
	});

	it.each(["processless", "exit", "error"] as const)("ends the startup presentation wait on %s", (ending) => {
		const { handle } = createHandle();
		handle.connectToTask("task-1", "project-1");
		const pending = vi.fn();
		handle.subscribe({ onContentPending: pending });
		const sockets = socketInstances[0]!;
		sockets.emitState(createTestTaskSessionSummary({ agentId: "claude", pid: 111, startedAt: 100 }));
		expect(pending).toHaveBeenLastCalledWith(true);
		if (ending === "processless") {
			sockets.emitState(createTestTaskSessionSummary({ agentId: "claude", pid: null, startedAt: 100 }));
		} else if (ending === "exit") sockets.emitExit();
		else sockets.emitError();
		expect(pending).toHaveBeenLastCalledWith(false);
	});

	it("does not wait for shell or processless retained content and waits again after an agent reset", () => {
		const { handle } = createHandle({ hasRenderedContent: () => true });
		handle.connectToTask("task-1", "project-1");
		const pending = vi.fn();
		handle.subscribe({ onContentPending: pending });
		const sockets = socketInstances[0]!;
		sockets.emitState(createTestTaskSessionSummary({ agentId: null, pid: 111 }));
		handle.notifyContentReset();
		expect(pending.mock.calls).toEqual([[false]]);
		sockets.emitState(createTestTaskSessionSummary({ agentId: "claude", pid: null }));
		handle.notifyContentReset();
		expect(pending.mock.calls).toEqual([[false]]);
		sockets.emitState(createTestTaskSessionSummary({ agentId: "claude", pid: 222 }));
		handle.notifyContentReset();
		expect(pending).toHaveBeenLastCalledWith(true);
	});

	it("captures image paste ownership before asynchronous file reads and rejects retargeting", async () => {
		const { handle } = createHandle();
		handle.connectToTask("task-1", "project-1");
		const sockets = socketInstances[0]!;
		sockets.isIoOpen = true;
		sockets.emitState(
			createTestTaskSessionSummary({ taskId: "task-1", agentId: "codex", sessionInstanceId: "first" }),
		);
		const writer = handle.beginImagePaste();
		expect(writer).not.toBeNull();
		sockets.emitState(
			createTestTaskSessionSummary({ taskId: "task-1", agentId: "codex", sessionInstanceId: "replacement" }),
		);
		await expect(writer!([])).rejects.toThrow("Terminal session changed");
		expect(getRuntimeTrpcClient).not.toHaveBeenCalled();
		handle.dispose();
	});

	it("does not offer image paste for disconnected or shell terminals", () => {
		const { handle } = createHandle();
		expect(handle.beginImagePaste()).toBeNull();
		handle.connectToTask("shell", "project-1");
		const sockets = socketInstances[0]!;
		sockets.isIoOpen = true;
		sockets.emitState(
			createTestTaskSessionSummary({ taskId: "shell", agentId: null, sessionInstanceId: "shell-launch" }),
		);
		expect(handle.beginImagePaste()).toBeNull();
		handle.dispose();
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
