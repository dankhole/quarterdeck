import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { PtySession } from "../../../src/terminal/pty-session";
import { createActiveProcessState, createProcessEntry } from "../../../src/terminal/session-manager-types";
import { processShellSessionOutput, processTaskSessionOutput } from "../../../src/terminal/session-output-pipeline";
import type { TerminalSessionService } from "../../../src/terminal/terminal-session-service";
import type { TerminalOutputCursor } from "../../../src/terminal/terminal-state-mirror";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";
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

describe("task output broadcast ordering", () => {
	it("keeps arrival order when the inspection predicate flips while broadcasts are deferred", async () => {
		let inspect = true;
		const session = { write: vi.fn(), wasInterrupted: vi.fn(() => false) } as unknown as PtySession;
		const entry = createProcessEntry("task-1");
		entry.active = createActiveProcessState({
			session,
			sessionInstanceId: "launch-1",
			agentId: "codex",
			cols: 80,
			rows: 24,
			willAutoTrust: false,
			launch: {
				args: [],
				env: {},
				detectOutputTransition: () => null,
				shouldInspectOutputForTransition: () => inspect,
			},
		});
		const mirror = new TerminalStateMirror(80, 24);
		mirrors.push(mirror);
		entry.terminalStateMirror = mirror;
		const received: string[] = [];
		entry.listeners.set(1, { onOutput: (chunk) => received.push(chunk.toString("utf8")) });
		const summary = createTestTaskSessionSummary({ agentId: "codex", state: "running" });
		const deps = {
			getSummary: vi.fn(() => summary),
			updateStore: vi.fn(() => summary),
			applyTransitionEvent: vi.fn(() => null),
		};
		const output = (data: string) => processTaskSessionOutput(entry, "task-1", Buffer.from(data), deps);

		output("first");
		inspect = false;
		output("second");
		expect(received).toEqual([]);

		const pending = mirror.getSnapshot();
		await vi.advanceTimersByTimeAsync(10);
		await pending;
		expect(received).toEqual(["first", "second"]);

		// Once the deferred queue drains, uninspected output is broadcast immediately.
		output("third");
		expect(received).toEqual(["first", "second", "third"]);
	});

	it.each([
		{ inspected: false, batching: false },
		{ inspected: true, batching: false },
		{ inspected: true, batching: true },
	])(
		"carries real mirror cursors through production fanout ($inspected, batching=$batching)",
		async ({ inspected, batching }) => {
			let inspect = inspected;
			const entry = createProcessEntry("task-1");
			entry.active = createActiveProcessState({
				session: { write: vi.fn(), wasInterrupted: vi.fn(() => false) } as unknown as PtySession,
				sessionInstanceId: "launch-1",
				agentId: "codex",
				cols: 80,
				rows: 24,
				willAutoTrust: false,
				launch: {
					args: [],
					env: {},
					detectOutputTransition: () => null,
					shouldInspectOutputForTransition: () => inspect,
				},
			});
			const mirror = new TerminalStateMirror(80, 24);
			mirrors.push(mirror);
			mirror.setBatching(batching);
			entry.terminalStateMirror = mirror;
			const summary = createTestTaskSessionSummary({ agentId: "codex", state: "running" });
			const deps = {
				getSummary: vi.fn(() => summary),
				updateStore: vi.fn(() => summary),
				applyTransitionEvent: vi.fn(() => null),
			};
			const terminalManager: TerminalSessionService = {
				attach: (_taskId, listener) => {
					entry.listeners.set(1, listener);
					return () => entry.listeners.delete(1);
				},
				getRestoreSnapshot: () => mirror.getSnapshot(),
				recoverStaleSession: vi.fn(() => null),
				writeInput: vi.fn(() => null),
				resize: vi.fn(() => true),
				pauseOutput: vi.fn(() => true),
				resumeOutput: vi.fn(() => true),
				stopTaskSession: vi.fn(() => null),
			};
			const coordinator = new TerminalWsRestoreCoordinator();
			const viewer = createTerminalViewerState("viewer-1");
			const ws = { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as WebSocket;
			const enqueueOutput = vi.fn();
			viewer.controlSocket = ws;
			viewer.ioSocket = ws;
			viewer.ioState = {
				enqueueOutput,
				acknowledgeOutput: vi.fn(),
				drainOutput: vi.fn(async () => true),
				dispose: vi.fn(),
			};
			const stream = createTerminalStreamState();
			stream.viewers.set(viewer.clientId, viewer);
			ensureTerminalWsOutputListener({
				streamState: stream,
				terminalManager,
				taskId: entry.taskId,
				restoreCoordinator: coordinator,
			});
			const cursors: Array<TerminalOutputCursor | null> = [];
			entry.listeners.set(2, { onOutput: (_chunk, outputCursor) => cursors.push(outputCursor) });
			coordinator.beginInitialRestore({ viewerState: viewer, ws, terminalManager, taskId: entry.taskId });

			processTaskSessionOutput(entry, entry.taskId, Buffer.from("first\r\n"), deps);
			inspect = false;
			processTaskSessionOutput(entry, entry.taskId, Buffer.from("second\r\n"), deps);
			await vi.advanceTimersByTimeAsync(110);
			expect(cursors).toEqual([
				{ streamId: expect.any(String), sequence: 1 },
				{ streamId: cursors[0]?.streamId, sequence: 2 },
			]);
			expect(viewer.restore.snapshotCursor).toEqual(cursors[1]);
			expect(enqueueOutput).not.toHaveBeenCalled();

			processTaskSessionOutput(entry, entry.taskId, Buffer.from("third"), deps);
			coordinator.completeRestore(viewer, ws);
			expect(enqueueOutput).toHaveBeenCalledExactlyOnceWith(Buffer.from("third"));
			expect(cursors[2]).toEqual({ streamId: cursors[0]?.streamId, sequence: 3 });
		},
	);

	it("does not lose inspected output when a disposed mirror rejects it", () => {
		const entry = createProcessEntry("task-disposed");
		entry.active = createActiveProcessState({
			session: { write: vi.fn() } as unknown as PtySession,
			sessionInstanceId: "launch-1",
			agentId: "codex",
			cols: 80,
			rows: 24,
			willAutoTrust: false,
			launch: { args: [], env: {}, detectOutputTransition: () => null },
		});
		const mirror = new TerminalStateMirror(80, 24);
		mirrors.push(mirror);
		entry.terminalStateMirror = mirror;
		mirror.dispose();
		const onOutput = vi.fn();
		entry.listeners.set(1, { onOutput });
		const summary = createTestTaskSessionSummary({ agentId: "codex", state: "running" });
		processTaskSessionOutput(entry, entry.taskId, Buffer.from("untracked"), {
			getSummary: () => summary,
			updateStore: () => summary,
			applyTransitionEvent: () => null,
		});
		expect(onOutput).toHaveBeenCalledExactlyOnceWith(Buffer.from("untracked"), null);
	});

	it("forwards shell mirror cursors and uses explicit null without a mirror", async () => {
		const entry = createProcessEntry("shell-1");
		entry.active = createActiveProcessState({
			session: { write: vi.fn() } as unknown as PtySession,
			sessionInstanceId: "launch-1",
			agentId: null,
			cols: 80,
			rows: 24,
			willAutoTrust: false,
			launch: { args: [], env: {} },
		});
		const onOutput = vi.fn();
		entry.listeners.set(1, { onOutput });
		processShellSessionOutput(entry, entry.taskId, Buffer.from("untracked"));
		expect(onOutput).toHaveBeenLastCalledWith(Buffer.from("untracked"), null);
		const mirror = new TerminalStateMirror(80, 24);
		mirrors.push(mirror);
		entry.terminalStateMirror = mirror;
		processShellSessionOutput(entry, entry.taskId, Buffer.from("tracked"));
		const pending = mirror.getSnapshot();
		await vi.advanceTimersByTimeAsync(10);
		const snapshot = await pending;
		expect(onOutput).toHaveBeenLastCalledWith(Buffer.from("tracked"), snapshot?.outputCursor);
	});
});
