import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlotVisibilityLifecycle } from "@/terminal/slot-visibility-lifecycle";

vi.mock("@/utils/client-logger", () => ({
	createClientLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

function setVisibilityState(state: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: state,
	});
}

describe("SlotVisibilityLifecycle", () => {
	beforeEach(() => {
		setVisibilityState("visible");
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("refreshes the terminal when the tab becomes visible", () => {
		const refreshTerminal = vi.fn();
		const reconnectSockets = vi.fn();
		const lifecycle = new SlotVisibilityLifecycle(7, {
			getTaskId: () => "task-1",
			getWorkspaceId: () => "ws-1",
			hasVisibleContainer: () => true,
			hasIoSocket: () => true,
			hasControlSocket: () => true,
			refreshTerminal,
			reconnectSockets,
			isDisposed: () => false,
		});

		document.dispatchEvent(new Event("visibilitychange"));

		expect(refreshTerminal).toHaveBeenCalledOnce();
		expect(reconnectSockets).not.toHaveBeenCalled();
		lifecycle.dispose();
	});

	it("reconnects sockets when a visible terminal returns with a dead connection", () => {
		const refreshTerminal = vi.fn();
		const reconnectSockets = vi.fn();
		const lifecycle = new SlotVisibilityLifecycle(8, {
			getTaskId: () => "task-2",
			getWorkspaceId: () => "ws-2",
			hasVisibleContainer: () => true,
			hasIoSocket: () => false,
			hasControlSocket: () => true,
			refreshTerminal,
			reconnectSockets,
			isDisposed: () => false,
		});

		document.dispatchEvent(new Event("visibilitychange"));

		expect(refreshTerminal).toHaveBeenCalledOnce();
		expect(reconnectSockets).toHaveBeenCalledWith("task-2", "ws-2");
		lifecycle.dispose();
	});

	it("ignores visibility changes when the terminal is hidden", () => {
		const refreshTerminal = vi.fn();
		const reconnectSockets = vi.fn();
		const lifecycle = new SlotVisibilityLifecycle(9, {
			getTaskId: () => "task-3",
			getWorkspaceId: () => "ws-3",
			hasVisibleContainer: () => false,
			hasIoSocket: () => false,
			hasControlSocket: () => false,
			refreshTerminal,
			reconnectSockets,
			isDisposed: () => false,
		});

		document.dispatchEvent(new Event("visibilitychange"));

		expect(refreshTerminal).not.toHaveBeenCalled();
		expect(reconnectSockets).not.toHaveBeenCalled();
		lifecycle.dispose();
	});
});
