import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { TerminalWsConnectionRegistry } from "../../../src/terminal/terminal-ws-connection-registry";
import type { IoOutputState } from "../../../src/terminal/terminal-ws-types";

function socket(): WebSocket {
	return { close: vi.fn() } as unknown as WebSocket;
}

function ioState(dispose = vi.fn()): IoOutputState {
	return {
		enqueueOutput: vi.fn(),
		acknowledgeOutput: vi.fn(),
		drainOutput: vi.fn(async () => true),
		dispose,
	};
}

describe("terminal connection replacement ownership", () => {
	it.each(["replace", "detach"])("preserves a newer IO owner when disposal reenters %s", (operation) => {
		const registry = new TerminalWsConnectionRegistry();
		const { viewerState } = registry.getOrCreateViewer("project:task", "viewer");
		const oldSocket = socket();
		const replacement = socket();
		const newest = socket();
		const newestState = ioState();
		const dispose = vi.fn(() => {
			registry.replaceIoConnection(viewerState, newest, newestState, "newest");
		});
		registry.replaceIoConnection(viewerState, oldSocket, ioState(dispose), "old");
		if (operation === "replace") registry.replaceIoConnection(viewerState, replacement, ioState(), "replacement");
		else registry.detachIoSocket("project:task", viewerState, oldSocket);
		expect(viewerState.ioSocket).toBe(newest);
		expect(viewerState.ioState).toBe(newestState);
		expect(viewerState.ioConnectionId).toBe("newest");
		expect(dispose).toHaveBeenCalledOnce();
		expect(registry.getOrCreateViewer("project:task", "viewer").viewerState).toBe(viewerState);
	});

	it.each(["replace", "detach"])("preserves a newer control listener when cleanup reenters %s", (operation) => {
		const registry = new TerminalWsConnectionRegistry();
		const { viewerState } = registry.getOrCreateViewer("project:task", "viewer");
		const oldSocket = socket();
		const newest = socket();
		const newestDetach = vi.fn();
		registry.replaceControlConnection(viewerState, oldSocket, "old");
		registry.replaceControlListener(viewerState, () => {
			registry.replaceControlConnection(viewerState, newest, "newest");
			registry.replaceControlListener(viewerState, newestDetach);
		});
		if (operation === "replace") registry.replaceControlListener(viewerState, vi.fn());
		else registry.detachControlSocket("project:task", viewerState, oldSocket);
		expect(viewerState.controlSocket).toBe(newest);
		expect(viewerState.detachControlListener).toBe(newestDetach);
		expect(viewerState.controlConnectionId).toBe("newest");
	});
});
