import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlotRenderer } from "@/terminal/slot-renderer";
import { SlotResizeManager } from "@/terminal/slot-resize-manager";
import { SlotWriteQueue } from "@/terminal/slot-write-queue";
import { TerminalViewport } from "@/terminal/terminal-viewport";

const appearance = { cursorColor: "#ffffff", terminalBackgroundColor: "#000000" };

describe("TerminalViewport pending autofocus", () => {
	let viewport: TerminalViewport;
	let container: HTMLDivElement;
	let host: HTMLElement;
	let outside: HTMLInputElement;
	let disposed: boolean;
	let nextFrame: number;
	let frames: Map<number, FrameRequestCallback>;
	const focus = vi.fn();

	beforeEach(() => {
		disposed = false;
		nextFrame = 0;
		frames = new Map();
		focus.mockClear();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			const id = ++nextFrame;
			frames.set(id, callback);
			return id;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
		// Keep the real viewport, input owner and xterm; skip browser rendering/measurement.
		vi.spyOn(SlotRenderer.prototype, "openWhenFontsReady").mockImplementation(() => {});
		vi.spyOn(SlotRenderer.prototype, "listenForDprChange").mockImplementation(() => {});
		vi.spyOn(SlotResizeManager.prototype, "observe").mockImplementation(() => {});
		vi.spyOn(FitAddon.prototype, "fit").mockImplementation(() => {});
		vi.spyOn(Terminal.prototype, "focus").mockImplementation(focus);
		viewport = new TerminalViewport(1, appearance, {
			clearGeometry: vi.fn(),
			getConnectedTaskId: () => "task-focus",
			getSessionAgentId: () => null,
			beginImagePaste: () => null,
			isDisposed: () => disposed,
			notifyOutputText: vi.fn(),
			reportGeometry: vi.fn(),
			sendControlMessage: () => true,
			sendIoData: () => true,
		});
		container = document.createElement("div");
		outside = document.createElement("input");
		document.body.append(container, outside);
		viewport.attachToStageContainer(container);
		host = container.firstElementChild as HTMLElement;
	});

	afterEach(() => {
		if (!disposed) viewport.dispose();
		container.remove();
		outside.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	function show(autoFocus = true, restoreCompleted = false): void {
		viewport.show(appearance, { autoFocus, restoreCompleted });
	}

	async function advanceFrame(): Promise<void> {
		const callbacks = [...frames.values()];
		frames.clear();
		for (const callback of callbacks) callback(0);
		// Drain the reveal continuation and the write-queue drain before the next frame.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	async function reveal(): Promise<void> {
		const completed = viewport.finalizeRestorePresentation({ hasActiveIoSocket: true });
		await advanceFrame();
		await advanceFrame();
		expect(await completed).toBe(true);
	}

	it("focuses once only after both layout frames and queued writes settle", async () => {
		let releaseWrites: () => void = () => {};
		vi.spyOn(SlotWriteQueue.prototype, "drain").mockReturnValueOnce(
			new Promise<void>((resolve) => {
				releaseWrites = resolve;
			}),
		);
		show();
		const completed = viewport.finalizeRestorePresentation({ hasActiveIoSocket: true });
		expect(focus).not.toHaveBeenCalled();
		await advanceFrame();
		expect(focus).not.toHaveBeenCalled();
		expect(host.style.visibility).toBe("hidden");
		releaseWrites();
		await Promise.resolve();
		await Promise.resolve();
		await advanceFrame();
		expect(await completed).toBe(true);
		expect(host.style.visibility).toBe("visible");
		expect(focus).toHaveBeenCalledOnce();
	});

	it.each(["focusin", "pointerdown", "keydown"])("cancels on another surface's %s while pending", async (type) => {
		show();
		const completed = viewport.finalizeRestorePresentation({ hasActiveIoSocket: true });
		await advanceFrame();
		outside.dispatchEvent(new Event(type, { bubbles: true }));
		await advanceFrame();
		expect(await completed).toBe(true);
		expect(focus).not.toHaveBeenCalled();
		show();
		await reveal();
		expect(focus).not.toHaveBeenCalled();
	});

	it("cancels when actual focus moves to another input before restore", async () => {
		show();
		outside.focus();
		await reveal();
		expect(document.activeElement).toBe(outside);
		expect(focus).not.toHaveBeenCalled();
	});

	it("cancels on window blur while pending", async () => {
		show();
		window.dispatchEvent(new Event("blur"));
		await reveal();
		expect(focus).not.toHaveBeenCalled();
	});

	it("leaves interaction inside this terminal and ordinary input alone", async () => {
		show();
		const input = document.createElement("input");
		host.append(input);
		for (const type of ["focusin", "pointerdown", "keydown"]) {
			const event = new Event(type, { bubbles: true, cancelable: true });
			input.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		}
		await reveal();
		expect(focus).toHaveBeenCalledOnce();
	});

	it("does not rearm for repeated show, appearance updates or reconnect restores", async () => {
		show();
		show();
		await reveal();
		expect(focus).toHaveBeenCalledOnce();
		viewport.setAppearance({ ...appearance, cursorColor: "#eeeeee" });
		show(true, true);
		await advanceFrame();
		await advanceFrame();
		await reveal();
		expect(focus).toHaveBeenCalledOnce();
	});

	it("does not add autofocus after activation without it", async () => {
		show(false);
		show(true);
		await reveal();
		expect(focus).not.toHaveBeenCalled();
	});

	it("retains the request when a newer reveal supersedes an unfinished one", async () => {
		show(true, true);
		await advanceFrame();
		await reveal();
		expect(focus).toHaveBeenCalledOnce();
	});

	it.each(["hide", "park"] as const)(
		"cancels pending focus on %s and rearms on the next activation",
		async (action) => {
			show();
			const completed = viewport.finalizeRestorePresentation({ hasActiveIoSocket: true });
			await advanceFrame();
			viewport[action]();
			await completed;
			expect(focus).not.toHaveBeenCalled();
			viewport.attachToStageContainer(container);
			show();
			await reveal();
			expect(focus).toHaveBeenCalledOnce();
		},
	);

	it("cancels pending reveal and removes interaction listeners on disposal", async () => {
		const removeDocumentListener = vi.spyOn(document, "removeEventListener");
		const removeWindowListener = vi.spyOn(window, "removeEventListener");
		show();
		const completed = viewport.finalizeRestorePresentation({ hasActiveIoSocket: true });
		await advanceFrame();
		disposed = true;
		viewport.dispose();
		expect(await completed).toBe(false);
		expect(focus).not.toHaveBeenCalled();
		for (const type of ["focusin", "pointerdown", "keydown"]) {
			expect(removeDocumentListener).toHaveBeenCalledWith(type, expect.any(Function), true);
		}
		expect(removeWindowListener).toHaveBeenCalledWith("blur", expect.any(Function));
	});

	it("preserves explicit focus and consumes pending autofocus", async () => {
		show();
		viewport.focus();
		expect(focus).toHaveBeenCalledOnce();
		await reveal();
		expect(focus).toHaveBeenCalledOnce();
	});
});
