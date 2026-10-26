import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type { RuntimeTerminalWsServerMessage } from "../../../src/core";
import type { PtySession } from "../../../src/terminal/pty-session";
import { createActiveProcessState, createProcessEntry } from "../../../src/terminal/session-manager-types";
import { processShellSessionOutput, processTaskSessionOutput } from "../../../src/terminal/session-output-pipeline";
import { MAX_RETAINED_TERMINAL_FRAME_BYTES } from "../../../src/terminal/terminal-output-framing";
import type { TerminalSessionService } from "../../../src/terminal/terminal-session-service";
import {
	TerminalRestoreSnapshotUnavailableError,
	TerminalStateMirror,
} from "../../../src/terminal/terminal-state-mirror";
import { ensureTerminalWsOutputListener } from "../../../src/terminal/terminal-ws-output-fanout";
import { TerminalWsRestoreCoordinator } from "../../../src/terminal/terminal-ws-restore-coordinator";
import { createTerminalStreamState, createTerminalViewerState } from "../../../src/terminal/terminal-ws-types";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const mirrors: TerminalStateMirror[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const mirror of mirrors.splice(0)) mirror.dispose();
	vi.useRealTimers();
});

function setup(kind: "task" | "shell", batching: boolean) {
	const entry = createProcessEntry("session-1");
	entry.active = createActiveProcessState({
		session: { write: vi.fn(), wasInterrupted: vi.fn(() => false) } as unknown as PtySession,
		sessionInstanceId: "launch-1",
		agentId: kind === "task" ? "codex" : null,
		cols: 80,
		rows: 24,
		willAutoTrust: false,
		launch: { args: [], env: {}, detectOutputTransition: () => null },
	});
	const mirror = new TerminalStateMirror(80, 24);
	mirrors.push(mirror);
	mirror.setBatching(batching);
	entry.terminalStateMirror = mirror;
	const summary = createTestTaskSessionSummary({ agentId: "codex", state: "running" });
	const deps = {
		getSummary: () => summary,
		updateStore: () => summary,
		applyTransitionEvent: () => null,
	};
	const output = (chunk: Buffer) => {
		if (kind === "task") processTaskSessionOutput(entry, entry.taskId, chunk, deps);
		else processShellSessionOutput(entry, entry.taskId, chunk);
	};
	const terminalManager: TerminalSessionService = {
		attach: (_taskId, listener) => {
			const id = entry.listenerIdCounter++;
			entry.listeners.set(id, listener);
			return () => entry.listeners.delete(id);
		},
		getRestoreSnapshot: () => mirror.getSnapshot(),
		recoverStaleSession: () => null,
		writeInput: () => null,
		resize: () => true,
		pauseOutput: () => true,
		resumeOutput: () => true,
		stopTaskSession: () => null,
	};
	const coordinator = new TerminalWsRestoreCoordinator();
	const stream = createTerminalStreamState();
	ensureTerminalWsOutputListener({
		streamState: stream,
		taskId: entry.taskId,
		terminalManager,
		restoreCoordinator: coordinator,
	});
	const broadcast: Buffer[] = [];
	terminalManager.attach(entry.taskId, { onOutput: (chunk) => broadcast.push(chunk) });
	const addViewer = (clientId: string) => {
		const viewer = createTerminalViewerState(clientId);
		const send = vi.fn<(data: string) => void>();
		const control = { OPEN: 1, readyState: 1, send, close: vi.fn() } as unknown as WebSocket;
		const io = { close: vi.fn() } as unknown as WebSocket;
		viewer.controlSocket = control;
		viewer.ioSocket = io;
		viewer.ioState = {
			enqueueOutput: vi.fn(),
			acknowledgeOutput: vi.fn(),
			drainOutput: async () => true,
			dispose: vi.fn(),
		};
		stream.viewers.set(clientId, viewer);
		return { viewer, control, io, send };
	};
	return { entry, mirror, output, terminalManager, coordinator, broadcast, addViewer };
}

describe("pipeline snapshot safety", () => {
	it.each([
		{ kind: "task" as const, batching: false },
		{ kind: "task" as const, batching: true },
		{ kind: "shell" as const, batching: false },
		{ kind: "shell" as const, batching: true },
	])(
		"refuses an overflowed $kind snapshot and restores a new viewer after completion (batching=$batching)",
		async ({ kind, batching }) => {
			const h = setup(kind, batching);
			const unsafeViewer = h.addViewer("unsafe");
			const oversized = Buffer.concat([
				Buffer.from("before\r\n\x1b]2;"),
				Buffer.alloc(MAX_RETAINED_TERMINAL_FRAME_BYTES + 1, "x"),
			]);
			h.output(oversized);
			expect(h.entry.active?.terminalProtocolFilter.framing.isSnapshotSafe).toBe(false);
			const refused = expect(h.mirror.getSnapshot()).rejects.toBeInstanceOf(TerminalRestoreSnapshotUnavailableError);
			await vi.advanceTimersByTimeAsync(20);
			await refused;
			expect(Buffer.concat(h.broadcast)).toEqual(oversized);
			h.coordinator.requestRestore({
				viewerState: unsafeViewer.viewer,
				ws: unsafeViewer.control,
				terminalManager: h.terminalManager,
				taskId: h.entry.taskId,
			});
			await vi.advanceTimersByTimeAsync(20);
			expect(unsafeViewer.send).not.toHaveBeenCalled();
			expect(unsafeViewer.viewer.restore.snapshotCursor).toBeNull();
			expect(unsafeViewer.control.close).toHaveBeenCalledWith(1013, expect.stringContaining("not snapshot-safe"));
			expect(unsafeViewer.io.close).toHaveBeenCalledWith(1013, expect.stringContaining("not snapshot-safe"));

			// A system notice bypasses framing and cannot prove parser recovery.
			h.mirror.applyOutput(Buffer.from("unframed system notice"));
			const stillRefused = expect(h.mirror.getSnapshot()).rejects.toBeInstanceOf(
				TerminalRestoreSnapshotUnavailableError,
			);
			await vi.advanceTimersByTimeAsync(20);
			await stillRefused;

			h.output(Buffer.from("\x07after\r\n"));
			expect(h.entry.active?.terminalProtocolFilter.framing.isSnapshotSafe).toBe(true);
			const safeSnapshot = h.mirror.getSnapshot();
			await vi.advanceTimersByTimeAsync(20);
			const snapshot = await safeSnapshot;
			expect(snapshot?.snapshot).toContain("before");
			expect(snapshot?.snapshot).toContain("after");
			const recovered = h.addViewer("recovered");
			h.coordinator.requestRestore({
				viewerState: recovered.viewer,
				ws: recovered.control,
				terminalManager: h.terminalManager,
				taskId: h.entry.taskId,
			});
			await vi.advanceTimersByTimeAsync(20);
			const restore = JSON.parse(recovered.send.mock.calls[0]?.[0] ?? "null") as RuntimeTerminalWsServerMessage;
			expect(restore).toEqual({ type: "restore", snapshot: snapshot?.snapshot, cols: 80, rows: 24 });
			expect(recovered.viewer.restore.snapshotCursor).toEqual(snapshot?.outputCursor);
			h.coordinator.completeRestore(recovered.viewer, recovered.control);
			expect(recovered.viewer.ioState?.enqueueOutput).not.toHaveBeenCalled();
			expect(recovered.control.close).not.toHaveBeenCalled();
		},
	);

	it.each(["task", "shell"] as const)(
		"keeps withheld under-cap %s fragments snapshot-safe without broadcasting empty output",
		async (kind) => {
			const h = setup(kind, false);
			h.output(Buffer.from("before\r\n\x1b]2;pending"));
			expect(h.entry.active?.terminalProtocolFilter.framing.pendingChunk).not.toBeNull();
			h.output(Buffer.from(" more pending"));
			const pending = h.mirror.getSnapshot();
			await vi.advanceTimersByTimeAsync(20);
			const snapshot = await pending;
			expect(snapshot?.outputCursor.sequence).toBe(1);
			expect(snapshot?.snapshot).toContain("before");
			expect(Buffer.concat(h.broadcast)).toEqual(Buffer.from("before\r\n"));
		},
	);
});
