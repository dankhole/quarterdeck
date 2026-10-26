import headlessTerminalModule, { type Terminal as HeadlessTerminal } from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type { RuntimeTerminalWsServerMessage } from "../../../src/core";
import type { TerminalSessionService } from "../../../src/terminal/terminal-session-service";
import {
	type TerminalOutputCursor,
	type TerminalRestoreSnapshot,
	TerminalStateMirror,
} from "../../../src/terminal/terminal-state-mirror";
import { createTerminalWsIoOutputState } from "../../../src/terminal/terminal-ws-backpressure-policy";
import { TerminalWsConnectionRegistry } from "../../../src/terminal/terminal-ws-connection-registry";
import {
	TERMINAL_RESTORE_MAX_PENDING_BYTES,
	TERMINAL_RESTORE_MAX_PENDING_CHUNKS,
	TERMINAL_RESTORE_TIMEOUT_MS,
	TerminalWsRestoreCoordinator,
} from "../../../src/terminal/terminal-ws-restore-coordinator";
import { createTerminalStreamState, createTerminalViewerState } from "../../../src/terminal/terminal-ws-types";

const { Terminal } = headlessTerminalModule as { Terminal: typeof HeadlessTerminal };
const disposables: Array<{ dispose(): void }> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const disposable of disposables.splice(0)) disposable.dispose();
	vi.useRealTimers();
});

function cursor(sequence: number, streamId = "stream-1"): TerminalOutputCursor {
	return { streamId, sequence };
}

function snapshot(sequence: number, streamId = "stream-1"): TerminalRestoreSnapshot {
	return { snapshot: `snapshot-${sequence}`, cols: 80, rows: 24, outputCursor: cursor(sequence, streamId) };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

function createSocket() {
	const send = vi.fn<(data: string) => void>();
	const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send, close: vi.fn() } as unknown as WebSocket;
	return { ws, send };
}

function createViewer(clientId = "viewer-1") {
	const viewer = createTerminalViewerState(clientId);
	const { ws, send } = createSocket();
	const received: Buffer[] = [];
	viewer.controlSocket = ws;
	viewer.ioSocket = createSocket().ws;
	viewer.ioState = {
		enqueueOutput: (chunk) => received.push(chunk),
		acknowledgeOutput: vi.fn(),
		drainOutput: vi.fn(async () => true),
		dispose: vi.fn(),
	};
	return { viewer, ws, send, received };
}

function createManager(getRestoreSnapshot: TerminalSessionService["getRestoreSnapshot"]): TerminalSessionService {
	return {
		attach: vi.fn(() => null),
		getRestoreSnapshot,
		recoverStaleSession: vi.fn(() => null),
		writeInput: vi.fn(() => null),
		resize: vi.fn(() => true),
		pauseOutput: vi.fn(() => true),
		resumeOutput: vi.fn(() => true),
		stopTaskSession: vi.fn(() => null),
	};
}

function messages(send: ReturnType<typeof createSocket>["send"]): RuntimeTerminalWsServerMessage[] {
	return send.mock.calls.map(([data]) => JSON.parse(data) as RuntimeTerminalWsServerMessage);
}

function receivedText(received: Buffer[]): string {
	return Buffer.concat(received).toString("utf8");
}

async function renderedText(snapshotText: string, output: Buffer[]): Promise<string> {
	const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
	disposables.push(terminal);
	const written = new Promise<void>((resolve) => terminal.write(snapshotText + receivedText(output), resolve));
	await vi.advanceTimersByTimeAsync(10);
	await written;
	const buffer = terminal.buffer.active;
	return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "")
		.join("\n")
		.trim();
}

describe("terminal restore output ownership", () => {
	it.each([false, true])(
		"restores pre-capture output once and retains newer output (batching=%s)",
		async (batching) => {
			const mirror = new TerminalStateMirror(80, 24);
			disposables.push(mirror);
			mirror.setBatching(batching);
			const { viewer, ws, send, received } = createViewer();
			const coordinator = new TerminalWsRestoreCoordinator();
			const terminalManager = createManager(() => mirror.getSnapshot());
			coordinator.beginInitialRestore({ viewerState: viewer, ws, terminalManager, taskId: "task-1" });
			const first = mirror.applyOutput(Buffer.from("before "));
			const second = mirror.applyOutput(Buffer.from("capture\r\n"));
			coordinator.handleLiveOutput(viewer, Buffer.from("before "), first);
			coordinator.handleLiveOutput(viewer, Buffer.from("capture\r\n"), second);
			await vi.advanceTimersByTimeAsync(110);
			const restore = messages(send)[0];
			expect(restore?.type).toBe("restore");
			if (restore?.type !== "restore") throw new Error("Expected restore");
			expect(Object.keys(restore).sort()).toEqual(["cols", "rows", "snapshot", "type"]);

			const after = mirror.applyOutput(Buffer.from("after capture"));
			coordinator.handleLiveOutput(viewer, Buffer.from("after capture"), after);
			expect(received).toEqual([]);
			coordinator.completeRestore(viewer, ws);
			// A render-inspected broadcast can arrive after snapshot and ack.
			coordinator.handleLiveOutput(viewer, Buffer.from("before "), first);
			coordinator.handleLiveOutput(viewer, Buffer.from("capture\r\n"), second);
			expect(receivedText(received)).toBe("after capture");
			expect(await renderedText(restore.snapshot, received)).toBe("before capture\nafter capture");
		},
	);

	it("keeps a write accepted immediately after the real snapshot barrier", async () => {
		const mirror = new TerminalStateMirror(80, 24);
		disposables.push(mirror);
		const { viewer, ws, send, received } = createViewer();
		const coordinator = new TerminalWsRestoreCoordinator();
		const terminalManager = createManager(() => {
			const captured = mirror.getSnapshot();
			const second = mirror.applyOutput(Buffer.from("second"));
			coordinator.handleLiveOutput(viewer, Buffer.from("second"), second);
			return captured;
		});
		const first = mirror.applyOutput(Buffer.from("first "));
		coordinator.handleLiveOutput(viewer, Buffer.from("first "), first);
		coordinator.requestRestore({ viewerState: viewer, ws, terminalManager, taskId: "task-1" });
		await vi.advanceTimersByTimeAsync(10);
		expect(viewer.restore.snapshotCursor).toEqual(first);
		coordinator.completeRestore(viewer, ws);
		const restore = messages(send)[0];
		if (restore?.type !== "restore") throw new Error("Expected restore");
		expect(await renderedText(restore.snapshot, received)).toBe("first second");
	});

	it("uses independent viewer watermarks and never suppresses replacement streams or untracked output", async () => {
		const coordinator = new TerminalWsRestoreCoordinator();
		const first = createViewer("first");
		const second = createViewer("second");
		for (const [index, target] of [first, second].entries()) {
			const terminalManager = createManager(async () => snapshot(index + 1));
			coordinator.requestRestore({ viewerState: target.viewer, ws: target.ws, terminalManager, taskId: "task-1" });
		}
		await vi.advanceTimersByTimeAsync(0);
		for (const target of [first, second]) {
			for (const sequence of [1, 2, 3]) {
				coordinator.handleLiveOutput(target.viewer, Buffer.from(String(sequence)), cursor(sequence));
			}
			coordinator.handleLiveOutput(target.viewer, Buffer.from("replacement"), cursor(1, "stream-2"));
			coordinator.handleLiveOutput(target.viewer, Buffer.from("untracked"), null);
			coordinator.completeRestore(target.viewer, target.ws);
		}
		expect(receivedText(first.received)).toBe("23replacementuntracked");
		expect(receivedText(second.received)).toBe("3replacementuntracked");
	});

	it.each([false, true])("ignores a superseded same-socket capture (failure=%s)", async (failure) => {
		const older = deferred<TerminalRestoreSnapshot>();
		const newer = deferred<TerminalRestoreSnapshot>();
		const getRestoreSnapshot = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
		const terminalManager = createManager(getRestoreSnapshot);
		const onSnapshotFailed = vi.fn();
		const coordinator = new TerminalWsRestoreCoordinator({ onSnapshotFailed });
		const { viewer, ws, send, received } = createViewer();
		const request = { viewerState: viewer, ws, terminalManager, taskId: "task-1" };
		coordinator.requestRestore(request);
		await vi.advanceTimersByTimeAsync(0);
		coordinator.handleLiveOutput(viewer, Buffer.from("buffered"), cursor(3));
		coordinator.requestRestore(request);
		newer.resolve(snapshot(2));
		await vi.advanceTimersByTimeAsync(0);
		coordinator.completeRestore(viewer, ws);
		if (failure) older.reject(new Error("stale failure"));
		else older.resolve(snapshot(99));
		await vi.advanceTimersByTimeAsync(0);
		expect(messages(send)).toEqual([{ type: "restore", snapshot: "snapshot-2", cols: 80, rows: 24 }]);
		expect(viewer.restore.snapshotCursor).toEqual(cursor(2));
		expect(receivedText(received)).toBe("buffered");
		expect(onSnapshotFailed).not.toHaveBeenCalled();
	});

	it("rejects replaced control sockets and stale async captures", async () => {
		const pending = deferred<TerminalRestoreSnapshot>();
		const terminalManager = createManager(
			vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(snapshot(2)),
		);
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws: oldWs, send: oldSend, received } = createViewer();
		coordinator.requestRestore({ viewerState: viewer, ws: oldWs, terminalManager, taskId: "task-1" });
		await vi.advanceTimersByTimeAsync(0);
		const { ws, send } = createSocket();
		viewer.controlSocket = ws;
		const request = { viewerState: viewer, ws, terminalManager, taskId: "task-1" };
		coordinator.beginInitialRestore(request);
		await vi.advanceTimersByTimeAsync(110);
		coordinator.handleLiveOutput(viewer, Buffer.from("new output"), cursor(3));
		coordinator.completeRestore(viewer, oldWs);
		coordinator.requestRestore({ ...request, ws: oldWs });
		coordinator.handleResize({ ...request, ws: oldWs, cols: 1, rows: 1 });
		expect(received).toEqual([]);
		expect(terminalManager.resize).not.toHaveBeenCalled();
		pending.resolve(snapshot(99));
		await vi.advanceTimersByTimeAsync(0);
		expect(oldSend).not.toHaveBeenCalled();
		expect(messages(send)).toHaveLength(1);
		expect(viewer.restore.snapshotCursor).toEqual(cursor(2));
		coordinator.completeRestore(viewer, ws);
		expect(receivedText(received)).toBe("new output");
	});

	it("serializes same-socket restores behind the outstanding snapshot acknowledgement", async () => {
		const pending = deferred<TerminalRestoreSnapshot>();
		const getRestoreSnapshot = vi.fn().mockResolvedValueOnce(snapshot(1)).mockReturnValueOnce(pending.promise);
		const terminalManager = createManager(getRestoreSnapshot);
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws, send, received } = createViewer();
		const request = { viewerState: viewer, ws, terminalManager, taskId: "task-1" };
		coordinator.requestRestore(request);
		// Unsolicited/old acknowledgements cannot complete an unsent capture.
		coordinator.completeRestore(viewer, ws);
		expect(viewer.restore.restoreComplete).toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		coordinator.handleLiveOutput(viewer, Buffer.from("covered next"), cursor(2));
		coordinator.requestRestore(request);
		coordinator.requestRestore(request);
		expect(getRestoreSnapshot).toHaveBeenCalledTimes(1);
		coordinator.completeRestore(viewer, ws);
		await vi.advanceTimersByTimeAsync(0);
		expect(getRestoreSnapshot).toHaveBeenCalledTimes(2);
		expect(received).toEqual([]);
		coordinator.completeRestore(viewer, ws);
		expect(viewer.restore.restoreComplete).toBe(false);
		pending.resolve(snapshot(2));
		await vi.advanceTimersByTimeAsync(0);
		expect(messages(send)).toHaveLength(2);
		coordinator.handleLiveOutput(viewer, Buffer.from("newer"), cursor(3));
		expect(received).toEqual([]);
		coordinator.completeRestore(viewer, ws);
		expect(receivedText(received)).toBe("newer");
	});

	it.each(["null", "failure"])("preserves buffered bytes when a replacement capture returns %s", async (outcome) => {
		const older = deferred<TerminalRestoreSnapshot>();
		const getRestoreSnapshot = vi.fn().mockReturnValueOnce(older.promise);
		if (outcome === "null") getRestoreSnapshot.mockResolvedValueOnce(null);
		else getRestoreSnapshot.mockRejectedValueOnce(new Error("capture failed"));
		const terminalManager = createManager(getRestoreSnapshot);
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws, send, received } = createViewer();
		const request = { viewerState: viewer, ws, terminalManager, taskId: "task-1" };
		coordinator.requestRestore(request);
		await vi.advanceTimersByTimeAsync(0);
		coordinator.handleLiveOutput(viewer, Buffer.from("retained"), cursor(1));
		coordinator.handleLiveOutput(viewer, Buffer.from("untracked"), null);
		coordinator.requestRestore(request);
		await vi.advanceTimersByTimeAsync(0);
		older.resolve(snapshot(99));
		await vi.advanceTimersByTimeAsync(0);
		coordinator.completeRestore(viewer, ws);
		expect(messages(send)).toEqual([{ type: "restore", snapshot: "", cols: null, rows: null }]);
		expect(receivedText(received)).toBe("retaineduntracked");
		expect(viewer.restore.snapshotCursor).toBeNull();
	});

	it("retains buffered output through an IO gap without accumulating covered late broadcasts", async () => {
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws, received } = createViewer();
		const ioSocket = viewer.ioSocket;
		const ioState = viewer.ioState;
		coordinator.requestRestore({
			viewerState: viewer,
			ws,
			terminalManager: createManager(async () => snapshot(1)),
			taskId: "task-1",
		});
		await vi.advanceTimersByTimeAsync(0);
		coordinator.handleLiveOutput(viewer, Buffer.from("retained"), cursor(2));
		viewer.ioSocket = null;
		viewer.ioState = null;
		coordinator.handleLiveOutput(viewer, Buffer.from("already covered"), cursor(1));
		coordinator.completeRestore(viewer, ws);
		expect(received).toEqual([]);
		viewer.ioSocket = ioSocket;
		viewer.ioState = ioState;
		coordinator.onIoSocketConnected(viewer);
		expect(receivedText(received)).toBe("retained");
	});

	it("fences pending batches and outstanding IO acknowledgements before resync capture", async () => {
		const getRestoreSnapshot = vi.fn().mockResolvedValueOnce(snapshot(0)).mockResolvedValueOnce(snapshot(2));
		const terminalManager = createManager(getRestoreSnapshot);
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws } = createViewer();
		const ioSocket = createSocket();
		viewer.ioSocket = ioSocket.ws;
		const ioState = createTerminalWsIoOutputState({
			ws: ioSocket.ws,
			streamState: createTerminalStreamState(),
			clientId: viewer.clientId,
			taskId: "task-1",
			terminalManager,
		});
		disposables.push(ioState);
		viewer.ioState = ioState;
		const request = { viewerState: viewer, ws, terminalManager, taskId: "task-1" };
		coordinator.requestRestore(request);
		await vi.advanceTimersByTimeAsync(0);
		coordinator.completeRestore(viewer, ws);
		coordinator.handleLiveOutput(viewer, Buffer.from("first"), cursor(1));
		coordinator.handleLiveOutput(viewer, Buffer.from("second"), cursor(2));
		expect(ioSocket.send).toHaveBeenCalledTimes(1);
		coordinator.requestRestore(request);
		expect(ioSocket.send).toHaveBeenCalledTimes(2);
		coordinator.handleLiveOutput(viewer, Buffer.from("newer"), cursor(3));
		await vi.advanceTimersByTimeAsync(10);
		expect(getRestoreSnapshot).toHaveBeenCalledTimes(1);
		ioState.acknowledgeOutput(5);
		await vi.advanceTimersByTimeAsync(0);
		expect(getRestoreSnapshot).toHaveBeenCalledTimes(1);
		ioState.acknowledgeOutput(6);
		await vi.advanceTimersByTimeAsync(0);
		expect(getRestoreSnapshot).toHaveBeenCalledTimes(2);
		coordinator.completeRestore(viewer, ws);
		await vi.advanceTimersByTimeAsync(4);
		expect(ioSocket.send.mock.calls.map(([data]) => data.toString())).toEqual(["first", "second", "newer"]);
	});

	it.each([false, true])(
		"waits for replacement IO when the old drain fails before detachment (detach=%s)",
		async (detach) => {
			const registry = new TerminalWsConnectionRegistry();
			const { viewerState: viewer, streamState } = registry.getOrCreateViewer("project:task", "viewer");
			const control = createSocket();
			registry.replaceControlConnection(viewer, control.ws, "new-control");
			const getRestoreSnapshot = vi.fn(async () => snapshot(0));
			const terminalManager = createManager(getRestoreSnapshot);
			const coordinator = new TerminalWsRestoreCoordinator();
			const oldSocket = createSocket();
			const oldState = createTerminalWsIoOutputState({
				ws: oldSocket.ws,
				streamState,
				clientId: viewer.clientId,
				taskId: "task",
				terminalManager,
			});
			disposables.push(oldState);
			registry.replaceIoConnection(viewer, oldSocket.ws, oldState, "old-io");
			(oldSocket.ws as unknown as { readyState: number }).readyState = 2;
			const request = { viewerState: viewer, ws: control.ws, terminalManager, taskId: "task" };
			coordinator.beginInitialRestore(request);
			coordinator.handleResize({ ...request, cols: 80, rows: 24 });
			await vi.advanceTimersByTimeAsync(0);
			expect(getRestoreSnapshot).not.toHaveBeenCalled();
			expect(control.ws.close).not.toHaveBeenCalled();
			expect(control.send).not.toHaveBeenCalled();

			if (detach) {
				registry.detachIoSocket("project:task", viewer, oldSocket.ws);
				coordinator.onIoSocketDisconnected(viewer);
			}
			const replacement = createSocket();
			const replacementState = createTerminalWsIoOutputState({
				ws: replacement.ws,
				streamState,
				clientId: viewer.clientId,
				taskId: "task",
				terminalManager,
			});
			disposables.push(replacementState);
			replacementState.enqueueOutput(Buffer.from("pending replacement output"));
			registry.replaceIoConnection(viewer, replacement.ws, replacementState, "new-io");
			coordinator.onIoSocketConnected(viewer);
			await vi.advanceTimersByTimeAsync(0);
			expect(getRestoreSnapshot).not.toHaveBeenCalled();
			replacementState.acknowledgeOutput(Buffer.byteLength("pending replacement output"));
			await vi.advanceTimersByTimeAsync(0);
			expect(getRestoreSnapshot).toHaveBeenCalledOnce();
			expect(messages(control.send)).toEqual([{ type: "restore", snapshot: "snapshot-0", cols: 80, rows: 24 }]);
			expect(control.ws.close).not.toHaveBeenCalled();
			coordinator.completeRestore(viewer, control.ws);
			expect(viewer.restore.restoreComplete).toBe(true);
		},
	);

	it("rechecks replaced IO ownership after awaiting the previous drain", async () => {
		const older = deferred<boolean>();
		const newer = deferred<boolean>();
		const getRestoreSnapshot = vi.fn(async () => snapshot(0));
		const terminalManager = createManager(getRestoreSnapshot);
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws } = createViewer();
		if (!viewer.ioState) throw new Error("Expected IO");
		viewer.ioState.drainOutput = () => older.promise;
		coordinator.requestRestore({ viewerState: viewer, ws, terminalManager, taskId: "task-1" });
		viewer.ioState = { ...viewer.ioState, drainOutput: () => newer.promise };
		older.resolve(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(getRestoreSnapshot).not.toHaveBeenCalled();
		newer.resolve(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(getRestoreSnapshot).toHaveBeenCalledOnce();
	});

	it("rechecks IO replacement in the drain helper's resolution microtask gap", async () => {
		const older = deferred<boolean>();
		const newer = deferred<boolean>();
		const getRestoreSnapshot = vi.fn(async () => snapshot(0));
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws } = createViewer();
		if (!viewer.ioState) throw new Error("Expected IO");
		viewer.ioState.drainOutput = () => older.promise;
		const replacement = { ...viewer.ioState, drainOutput: () => newer.promise };
		coordinator.requestRestore({
			viewerState: viewer,
			ws,
			terminalManager: createManager(getRestoreSnapshot),
			taskId: "task-1",
		});
		older.resolve(true);
		// This runs after the helper observes the old IO drained, but before
		// the caller receives that helper's resolution and starts capture.
		await Promise.resolve().then(() => {
			viewer.ioState = replacement;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(getRestoreSnapshot).not.toHaveBeenCalled();
		newer.resolve(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(getRestoreSnapshot).toHaveBeenCalledOnce();
	});

	it("does not lose pending output when a flush reenters restore", async () => {
		const getRestoreSnapshot = vi.fn().mockResolvedValueOnce(snapshot(0)).mockResolvedValueOnce(snapshot(1));
		const terminalManager = createManager(getRestoreSnapshot);
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws, received } = createViewer();
		const request = { viewerState: viewer, ws, terminalManager, taskId: "task-1" };
		coordinator.requestRestore(request);
		await vi.advanceTimersByTimeAsync(0);
		coordinator.handleLiveOutput(viewer, Buffer.from("first"), cursor(1));
		coordinator.handleLiveOutput(viewer, Buffer.from("second"), cursor(2));
		if (!viewer.ioState) throw new Error("Expected IO");
		viewer.ioState.enqueueOutput = (chunk) => {
			received.push(chunk);
			if (chunk.toString() === "first") coordinator.requestRestore(request);
		};
		coordinator.completeRestore(viewer, ws);
		expect(receivedText(received)).toBe("first");
		await vi.advanceTimersByTimeAsync(0);
		coordinator.completeRestore(viewer, ws);
		expect(receivedText(received)).toBe("firstsecond");
		expect(viewer.restore.pendingOutputBytes).toBe(0);
	});

	it("preserves arrival order and resolves IO ownership during a reentrant flush", async () => {
		const terminalManager = createManager(async () => snapshot(0));
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws, received } = createViewer();
		coordinator.requestRestore({ viewerState: viewer, ws, terminalManager, taskId: "task-1" });
		await vi.advanceTimersByTimeAsync(0);
		coordinator.handleLiveOutput(viewer, Buffer.from("first"), cursor(1));
		coordinator.handleLiveOutput(viewer, Buffer.from("second"), cursor(2));
		const replacementReceived: Buffer[] = [];
		if (!viewer.ioState) throw new Error("Expected IO");
		const previousIoState = viewer.ioState;
		viewer.ioState.enqueueOutput = (chunk) => {
			received.push(chunk);
			coordinator.handleLiveOutput(viewer, Buffer.from("third"), cursor(3));
			viewer.ioState = { ...previousIoState, enqueueOutput: (data) => replacementReceived.push(data) };
			viewer.ioSocket = createSocket().ws;
			coordinator.onIoSocketConnected(viewer);
		};
		coordinator.completeRestore(viewer, ws);
		expect(receivedText(received)).toBe("first");
		expect(receivedText(replacementReceived)).toBe("secondthird");
		expect(viewer.restore.pendingOutputBytes).toBe(0);
	});

	it.each([false, true])(
		"does not send a second restore when a diagnostics observer throws (failure=%s)",
		async (failure) => {
			const terminalManager = createManager(
				failure
					? async () => {
							throw new Error("capture");
						}
					: async () => snapshot(2),
			);
			const observer = () => {
				throw new Error("observer");
			};
			const coordinator = new TerminalWsRestoreCoordinator({ onSnapshotSent: observer, onSnapshotFailed: observer });
			const { viewer, ws, send } = createViewer();
			coordinator.requestRestore({ viewerState: viewer, ws, terminalManager, taskId: "task-1" });
			await vi.advanceTimersByTimeAsync(0);
			expect(messages(send)).toHaveLength(1);
			expect(viewer.restore.snapshotCursor).toEqual(failure ? null : cursor(2));
		},
	);

	it.each(["bytes", "chunks"])(
		"disconnects explicitly instead of silently truncating an oversized restore gap (%s)",
		(limit) => {
			const coordinator = new TerminalWsRestoreCoordinator();
			const { viewer, ws, received } = createViewer();
			const ioSocket = viewer.ioSocket;
			if (limit === "bytes") {
				coordinator.handleLiveOutput(viewer, Buffer.alloc(TERMINAL_RESTORE_MAX_PENDING_BYTES + 1), cursor(1));
			} else {
				for (let i = 0; i <= TERMINAL_RESTORE_MAX_PENDING_CHUNKS; i++) {
					coordinator.handleLiveOutput(viewer, Buffer.from("a"), cursor(i + 1));
				}
			}
			expect(ws.close).toHaveBeenCalledWith(1013, expect.stringContaining("reconnect"));
			expect(ioSocket?.close).toHaveBeenCalledWith(1013, expect.stringContaining("reconnect"));
			coordinator.handleLiveOutput(viewer, Buffer.from("after disconnect"), cursor(9999));
			expect(viewer.restore.pendingOutputChunks).toEqual([]);
			expect(viewer.restore.pendingOutputBytes).toBe(0);
			expect(received).toEqual([]);
		},
	);

	it("does not disconnect replacement sockets when abort disposal reenters attachment", async () => {
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws: previousControl } = createViewer();
		const previousIo = viewer.ioSocket;
		const replacementControl = createSocket();
		const replacementIo = createSocket();
		if (!viewer.ioState) throw new Error("Expected IO");
		const previousIoState = viewer.ioState;
		viewer.ioState.dispose = () => {
			viewer.controlSocket = replacementControl.ws;
			viewer.ioSocket = replacementIo.ws;
			viewer.ioState = { ...previousIoState, dispose: vi.fn() };
			coordinator.beginInitialRestore({
				viewerState: viewer,
				ws: replacementControl.ws,
				terminalManager: createManager(async () => snapshot(0)),
				taskId: "task-1",
			});
		};
		coordinator.handleLiveOutput(viewer, Buffer.alloc(TERMINAL_RESTORE_MAX_PENDING_BYTES + 1), cursor(1));
		expect(previousControl.close).toHaveBeenCalledOnce();
		expect(previousIo?.close).toHaveBeenCalledOnce();
		expect(replacementControl.ws.close).not.toHaveBeenCalled();
		expect(replacementIo.ws.close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(110);
		expect(messages(replacementControl.send)).toHaveLength(1);
		coordinator.completeRestore(viewer, replacementControl.ws);
		expect(viewer.restore.restoreComplete).toBe(true);
	});

	it("times out a stalled IO fence and cancels it on disposal without capturing a late snapshot", async () => {
		const getRestoreSnapshot = vi.fn(async () => snapshot(0));
		const terminalManager = createManager(getRestoreSnapshot);
		const coordinator = new TerminalWsRestoreCoordinator();
		const { viewer, ws, send } = createViewer();
		const ioSocket = createSocket();
		viewer.ioSocket = ioSocket.ws;
		const ioState = createTerminalWsIoOutputState({
			ws: ioSocket.ws,
			streamState: createTerminalStreamState(),
			clientId: viewer.clientId,
			taskId: "task-1",
			terminalManager,
		});
		disposables.push(ioState);
		viewer.ioState = ioState;
		ioState.enqueueOutput(Buffer.from("unacknowledged"));
		coordinator.requestRestore({ viewerState: viewer, ws, terminalManager, taskId: "task-1" });
		await vi.advanceTimersByTimeAsync(TERMINAL_RESTORE_TIMEOUT_MS);
		expect(ws.close).toHaveBeenCalledWith(1013, expect.stringContaining("timed out"));
		expect(ioSocket.ws.close).toHaveBeenCalledWith(1013, expect.stringContaining("timed out"));
		ioState.acknowledgeOutput(1000);
		await vi.advanceTimersByTimeAsync(0);
		expect(getRestoreSnapshot).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});
