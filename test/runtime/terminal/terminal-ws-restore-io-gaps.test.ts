import headlessModule, { type Terminal as HeadlessTerminal } from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type { RuntimeTerminalWsServerMessage } from "../../../src/core";
import type { TerminalSessionService } from "../../../src/terminal/terminal-session-service";
import {
	type TerminalOutputCursor,
	type TerminalRestoreSnapshot,
	TerminalStateMirror,
} from "../../../src/terminal/terminal-state-mirror";
import { TerminalWsRestoreCoordinator } from "../../../src/terminal/terminal-ws-restore-coordinator";
import { createTerminalViewerState, type IoOutputState } from "../../../src/terminal/terminal-ws-types";

const { Terminal } = headlessModule as { Terminal: typeof HeadlessTerminal };
const disposables: Array<{ dispose(): void }> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const disposable of disposables.splice(0)) disposable.dispose();
	vi.useRealTimers();
});

function socket() {
	const send = vi.fn<(data: string) => void>();
	return { ws: { OPEN: 1, readyState: 1, send, close: vi.fn() } as unknown as WebSocket, send };
}

function cursor(sequence: number, streamId = "original"): TerminalOutputCursor {
	return { streamId, sequence };
}

function snapshot(sequence: number, streamId = "original"): TerminalRestoreSnapshot {
	return { snapshot: `snapshot-${sequence}`, cols: 80, rows: 24, outputCursor: cursor(sequence, streamId) };
}

function setup(getSnapshot: TerminalSessionService["getRestoreSnapshot"]) {
	const viewer = createTerminalViewerState("viewer");
	const control = socket();
	const received: Buffer[] = [];
	const ioState: IoOutputState = {
		enqueueOutput: (chunk) => received.push(chunk),
		acknowledgeOutput: vi.fn(),
		drainOutput: async () => true,
		dispose: vi.fn(),
	};
	viewer.controlSocket = control.ws;
	const terminalManager: TerminalSessionService = {
		attach: () => null,
		getRestoreSnapshot: vi.fn(getSnapshot),
		recoverStaleSession: () => null,
		writeInput: () => null,
		resize: () => true,
		pauseOutput: () => true,
		resumeOutput: () => true,
		stopTaskSession: () => null,
	};
	const coordinator = new TerminalWsRestoreCoordinator();
	const request = { viewerState: viewer, ws: control.ws, terminalManager, taskId: "task" };
	const attachIo = () => {
		viewer.ioSocket = socket().ws;
		viewer.ioState = ioState;
		coordinator.onIoSocketConnected(viewer);
	};
	const detachIo = () => {
		viewer.ioSocket = null;
		viewer.ioState = null;
		coordinator.onIoSocketDisconnected(viewer);
	};
	return { viewer, control, received, terminalManager, coordinator, request, attachIo, detachIo };
}

function restoreMessage(send: ReturnType<typeof socket>["send"], index: number) {
	const message = JSON.parse(send.mock.calls[index]?.[0] ?? "null") as RuntimeTerminalWsServerMessage;
	if (message.type !== "restore") throw new Error("Expected restore");
	return message;
}

async function renderedText(snapshotText: string, received: Buffer[]) {
	const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
	disposables.push(terminal);
	const written = new Promise<void>((resolve) =>
		terminal.write(snapshotText + Buffer.concat(received).toString(), resolve),
	);
	await vi.advanceTimersByTimeAsync(10);
	await written;
	const buffer = terminal.buffer.active;
	return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "")
		.join("\n")
		.trim();
}

describe("terminal restore IO gaps", () => {
	it("preserves the initial resize defer when IO attaches before capture has started", async () => {
		const mirror = new TerminalStateMirror(80, 24);
		disposables.push(mirror);
		const h = setup(() => mirror.getSnapshot());
		h.coordinator.beginInitialRestore(h.request);
		const outputCursor = mirror.applyOutput(Buffer.from("before capture"));
		h.coordinator.handleLiveOutput(h.viewer, Buffer.from("before capture"), outputCursor);
		h.attachIo();
		await vi.advanceTimersByTimeAsync(90);
		expect(h.terminalManager.getRestoreSnapshot).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(20);
		expect(h.terminalManager.getRestoreSnapshot).toHaveBeenCalledOnce();
		h.coordinator.completeRestore(h.viewer, h.control.ws);
		expect(await renderedText(restoreMessage(h.control.send, 0).snapshot, h.received)).toBe("before capture");
	});

	it.each([false, true])(
		"recaptures output dropped after capture before releasing newly attached IO (acked=%s)",
		async (acked) => {
			const mirror = new TerminalStateMirror(80, 24);
			disposables.push(mirror);
			mirror.applyOutput(Buffer.from("before\r\n"));
			const h = setup(() => mirror.getSnapshot());
			h.coordinator.requestRestore(h.request);
			await vi.advanceTimersByTimeAsync(10);
			if (acked) h.coordinator.completeRestore(h.viewer, h.control.ws);
			const gap = mirror.applyOutput(Buffer.from("gap"));
			h.coordinator.handleLiveOutput(h.viewer, Buffer.from("gap"), gap);
			expect(h.viewer.restore.pendingOutputBytes).toBe(0);
			expect(h.viewer.restore.pendingOutputChunks).toEqual([]);
			h.attachIo();
			if (!acked) {
				await vi.advanceTimersByTimeAsync(10);
				expect(h.control.send).toHaveBeenCalledTimes(1);
				h.coordinator.completeRestore(h.viewer, h.control.ws);
			}
			await vi.advanceTimersByTimeAsync(10);
			expect(h.control.send).toHaveBeenCalledTimes(2);
			expect(h.received).toEqual([]);
			const later = mirror.applyOutput(Buffer.from(" later"));
			h.coordinator.handleLiveOutput(h.viewer, Buffer.from(" later"), later);
			expect(h.received).toEqual([]);
			h.coordinator.completeRestore(h.viewer, h.control.ws);
			expect(Buffer.concat(h.received).toString()).toBe(" later");
			expect(await renderedText(restoreMessage(h.control.send, 1).snapshot, h.received)).toBe("before\ngap later");
		},
	);

	it("recaptures a completed viewer after IO detachment without retaining the gap transcript", async () => {
		const mirror = new TerminalStateMirror(80, 24);
		disposables.push(mirror);
		mirror.applyOutput(Buffer.from("before\r\n"));
		const h = setup(() => mirror.getSnapshot());
		h.attachIo();
		h.coordinator.requestRestore(h.request);
		await vi.advanceTimersByTimeAsync(10);
		h.coordinator.completeRestore(h.viewer, h.control.ws);
		h.detachIo();
		for (const text of ["during ", "the ", "gap"]) {
			const outputCursor = mirror.applyOutput(Buffer.from(text));
			h.coordinator.handleLiveOutput(h.viewer, Buffer.from(text), outputCursor);
		}
		expect(h.viewer.restore.pendingOutputChunks).toEqual([]);
		h.attachIo();
		await vi.advanceTimersByTimeAsync(10);
		expect(h.control.send).toHaveBeenCalledTimes(2);
		expect(h.received).toEqual([]);
		h.coordinator.completeRestore(h.viewer, h.control.ws);
		expect(await renderedText(restoreMessage(h.control.send, 1).snapshot, h.received)).toBe("before\nduring the gap");
	});

	it("supersedes a capture when output was dropped before delayed IO attachment", async () => {
		let resolveOlder!: (value: TerminalRestoreSnapshot) => void;
		const older = new Promise<TerminalRestoreSnapshot>((resolve) => {
			resolveOlder = resolve;
		});
		const getSnapshot = vi.fn().mockReturnValueOnce(older).mockResolvedValueOnce(snapshot(2));
		const h = setup(getSnapshot);
		h.coordinator.requestRestore(h.request);
		await vi.advanceTimersByTimeAsync(0);
		h.coordinator.handleLiveOutput(h.viewer, Buffer.from("gap"), cursor(2));
		h.attachIo();
		await vi.advanceTimersByTimeAsync(0);
		resolveOlder(snapshot(1));
		await vi.advanceTimersByTimeAsync(0);
		expect(getSnapshot).toHaveBeenCalledTimes(2);
		expect(h.control.send).toHaveBeenCalledOnce();
		expect(h.viewer.restore.snapshotCursor).toEqual(cursor(2));
		h.coordinator.handleLiveOutput(h.viewer, Buffer.from("newer"), cursor(3));
		expect(h.received).toEqual([]);
		h.coordinator.completeRestore(h.viewer, h.control.ws);
		expect(Buffer.concat(h.received).toString()).toBe("newer");
	});

	it.each([cursor(1, "replacement"), null])(
		"invalidates the snapshot for dropped replacement/untracked output (%j)",
		async (outputCursor) => {
			const getSnapshot = vi
				.fn()
				.mockResolvedValueOnce(snapshot(100))
				.mockResolvedValueOnce(snapshot(1, "replacement"));
			const h = setup(getSnapshot);
			h.coordinator.requestRestore(h.request);
			await vi.advanceTimersByTimeAsync(0);
			h.coordinator.completeRestore(h.viewer, h.control.ws);
			h.coordinator.handleLiveOutput(h.viewer, Buffer.from("dropped"), outputCursor);
			h.attachIo();
			await vi.advanceTimersByTimeAsync(0);
			expect(getSnapshot).toHaveBeenCalledTimes(2);
			expect(h.viewer.restore.restoreComplete).toBe(false);
			expect(h.received).toEqual([]);
			h.coordinator.completeRestore(h.viewer, h.control.ws);
			expect(h.viewer.restore.snapshotCursor).toEqual(cursor(1, "replacement"));
		},
	);

	it("does not recapture late broadcasts already covered by the snapshot", async () => {
		const h = setup(async () => snapshot(2));
		h.coordinator.requestRestore(h.request);
		await vi.advanceTimersByTimeAsync(0);
		h.coordinator.completeRestore(h.viewer, h.control.ws);
		h.coordinator.handleLiveOutput(h.viewer, Buffer.from("covered"), cursor(1));
		h.attachIo();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.terminalManager.getRestoreSnapshot).toHaveBeenCalledOnce();
		expect(h.viewer.restore.restoreComplete).toBe(true);
	});

	it("does not resurrect an old control socket when IO attaches after a gap", async () => {
		const getSnapshot = vi.fn().mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(2));
		const h = setup(getSnapshot);
		h.coordinator.requestRestore(h.request);
		await vi.advanceTimersByTimeAsync(0);
		h.coordinator.completeRestore(h.viewer, h.control.ws);
		h.coordinator.handleLiveOutput(h.viewer, Buffer.from("gap"), cursor(2));
		const replacement = socket();
		h.viewer.controlSocket = replacement.ws;
		h.attachIo();
		h.coordinator.handleLiveOutput(h.viewer, Buffer.from("newer"), cursor(3));
		await vi.advanceTimersByTimeAsync(0);
		expect(getSnapshot).toHaveBeenCalledOnce();
		expect(h.received).toEqual([]);
		h.coordinator.beginInitialRestore({ ...h.request, ws: replacement.ws });
		await vi.advanceTimersByTimeAsync(110);
		h.coordinator.completeRestore(h.viewer, h.control.ws);
		expect(h.received).toEqual([]);
		h.coordinator.completeRestore(h.viewer, replacement.ws);
		expect(h.control.send).toHaveBeenCalledOnce();
		expect(replacement.send).toHaveBeenCalledOnce();
		expect(Buffer.concat(h.received).toString()).toBe("newer");
	});

	it.each(["null", "failure"])(
		"disconnects instead of claiming dropped output recovered after a %s recapture",
		async (outcome) => {
			const getSnapshot = vi.fn().mockResolvedValueOnce(snapshot(1));
			if (outcome === "null") getSnapshot.mockResolvedValueOnce(null);
			else getSnapshot.mockRejectedValueOnce(new Error("recapture failed"));
			const h = setup(getSnapshot);
			h.coordinator.requestRestore(h.request);
			await vi.advanceTimersByTimeAsync(0);
			h.coordinator.completeRestore(h.viewer, h.control.ws);
			h.coordinator.handleLiveOutput(h.viewer, Buffer.from("gap"), cursor(2));
			h.attachIo();
			await vi.advanceTimersByTimeAsync(0);
			expect(h.control.send).toHaveBeenCalledOnce();
			expect(h.control.ws.close).toHaveBeenCalledWith(1013, expect.stringContaining("recovery unavailable"));
			expect(h.viewer.ioSocket?.close).toHaveBeenCalledWith(1013, expect.stringContaining("recovery unavailable"));
			expect(h.received).toEqual([]);
		},
	);
});
