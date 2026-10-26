import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type { TerminalSessionService } from "../../../src/terminal/terminal-session-service";
import { createTerminalWsIoOutputState } from "../../../src/terminal/terminal-ws-backpressure-policy";
import { createTerminalStreamState, type IoOutputState } from "../../../src/terminal/terminal-ws-types";

const states: IoOutputState[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const state of states.splice(0)) state.dispose();
	vi.useRealTimers();
});

function setup() {
	const send = vi.fn<(chunk: Buffer) => void>();
	const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send };
	const streamState = createTerminalStreamState();
	const pauseOutput = vi.fn(() => true);
	const resumeOutput = vi.fn(() => true);
	const state = createTerminalWsIoOutputState({
		ws: socket as unknown as WebSocket,
		streamState,
		clientId: "viewer-1",
		taskId: "task-1",
		terminalManager: { pauseOutput, resumeOutput } as unknown as TerminalSessionService,
	});
	states.push(state);
	return { state, socket, send, streamState, pauseOutput, resumeOutput };
}

describe("terminal IO drain fence", () => {
	it("flushes the pending 4ms batch and waits for both outstanding and newly flushed bytes", async () => {
		const { state, send } = setup();
		state.enqueueOutput(Buffer.from("first"));
		state.enqueueOutput(Buffer.from("second"));
		expect(send.mock.calls.map(([chunk]) => chunk.toString())).toEqual(["first"]);
		const settled = vi.fn();
		const drain = state.drainOutput().then(settled);
		expect(send.mock.calls.map(([chunk]) => chunk.toString())).toEqual(["first", "second"]);
		state.acknowledgeOutput(5);
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();
		state.acknowledgeOutput(6);
		await drain;
		expect(settled).toHaveBeenCalledWith(true);
		await vi.advanceTimersByTimeAsync(10);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("counts frames emitted while already backpressured and requires an exact zero ack balance", async () => {
		const { state, pauseOutput, resumeOutput } = setup();
		state.enqueueOutput(Buffer.alloc(100_001));
		await vi.advanceTimersByTimeAsync(4);
		expect(pauseOutput).toHaveBeenCalledOnce();
		state.enqueueOutput(Buffer.from("still-paused"));
		const settled = vi.fn();
		const drain = state.drainOutput().then(settled);
		state.acknowledgeOutput(100_001);
		await Promise.resolve();
		expect(resumeOutput).toHaveBeenCalledOnce();
		expect(settled).not.toHaveBeenCalled();
		state.acknowledgeOutput(Buffer.byteLength("still-paused"));
		await drain;
		expect(settled).toHaveBeenCalledWith(true);
	});

	it("settles every pending fence as cancelled on disposal and cannot resurrect output", async () => {
		const { state, send } = setup();
		state.enqueueOutput(Buffer.from("outstanding"));
		state.enqueueOutput(Buffer.from("pending"));
		const first = state.drainOutput();
		const second = state.drainOutput();
		state.dispose();
		await expect(first).resolves.toBe(false);
		await expect(second).resolves.toBe(false);
		state.enqueueOutput(Buffer.from("disposed"));
		state.acknowledgeOutput(100);
		await vi.advanceTimersByTimeAsync(100);
		expect(send).toHaveBeenCalledTimes(2);
		await expect(state.drainOutput()).resolves.toBe(false);
	});

	it("cancels a drain when disposal reenters a batch flush", async () => {
		const { state, send } = setup();
		state.enqueueOutput(Buffer.alloc(300));
		send.mockImplementation(() => state.dispose());
		await expect(state.drainOutput()).resolves.toBe(false);
		state.enqueueOutput(Buffer.from("not sent"));
		await vi.advanceTimersByTimeAsync(10);
		expect(send).toHaveBeenCalledOnce();
	});

	it("does not claim a closed socket drained successfully", async () => {
		const { state, socket } = setup();
		socket.readyState = 3;
		await expect(state.drainOutput()).resolves.toBe(false);
	});
});
