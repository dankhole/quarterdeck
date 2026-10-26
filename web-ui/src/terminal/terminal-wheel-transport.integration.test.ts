import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAgentId } from "@/runtime/types";
import { SlotRenderer } from "@/terminal/slot-renderer";
import { TerminalViewport } from "@/terminal/terminal-viewport";

/** Real xterm public DOM path, parser, encoder and onData/onBinary viewport wiring. */
describe("TerminalViewport wheel transport", () => {
	let terminal: Terminal;
	let viewport: TerminalViewport;
	let host: HTMLDivElement;
	let agentId: RuntimeAgentId;
	let handleWheel: (event: WheelEvent) => boolean;
	const send = vi.fn(() => true);

	beforeEach(async () => {
		agentId = "pi";
		send.mockClear();
		vi.spyOn(SlotRenderer.prototype, "openWhenFontsReady").mockImplementation(() => {});
		const attachWheel = Terminal.prototype.attachCustomWheelEventHandler;
		vi.spyOn(Terminal.prototype, "attachCustomWheelEventHandler").mockImplementation(function (
			this: Terminal,
			handler,
		) {
			terminal = this;
			handleWheel = handler;
			attachWheel.call(this, handler);
		});
		// jsdom does not perform font layout; supply deterministic 10px cells via DOM measurements.
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
			return this.classList.contains("xterm-char-measure-element") ? 320 : 800;
		});
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(10);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			return new DOMRect(0, 0, 800, this.classList.contains("xterm-screen") ? 300 : 10);
		});
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
		);
		viewport = new TerminalViewport(
			1,
			{ cursorColor: "#fff", terminalBackgroundColor: "#000" },
			{
				clearGeometry: vi.fn(),
				getConnectedTaskId: () => "wheel-task",
				getSessionAgentId: () => agentId,
				beginImagePaste: () => null,
				isDisposed: () => false,
				notifyOutputText: vi.fn(),
				reportGeometry: vi.fn(),
				sendControlMessage: () => true,
				sendIoData: send,
			},
		);
		host = document.createElement("div");
		document.body.append(host);
		terminal.resize(80, 30);
		terminal.open(host);
		await write("\x1b[?1049h\x1b[?1002h\x1b[?1006h");
	});

	afterEach(() => {
		viewport?.dispose();
		host?.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	function write(data: string): Promise<void> {
		return new Promise((resolve) => terminal.write(data, resolve));
	}

	function wheel(init: WheelEventInit = {}): void {
		terminal.element!.dispatchEvent(
			new WheelEvent("wheel", {
				bubbles: true,
				cancelable: true,
				deltaY: 60,
				clientX: 120,
				clientY: 150,
				...init,
			}),
		);
	}

	it.each(["pi", "codex"] as const)(
		"sends one immediate frame per %s physical wheel, followed by immediate typing",
		(agent) => {
			agentId = agent;
			const count = agent === "pi" ? 6 : 2;
			wheel();
			expect(send.mock.calls).toEqual([["\x1b[<65;13;16M".repeat(count)]]);
			wheel({ deltaY: -60 });
			terminal.input("a");
			terminal.input("日");
			terminal.input("\r");
			terminal.input("\x03");
			terminal.input("\x1b");
			expect(send.mock.calls).toEqual([
				["\x1b[<65;13;16M".repeat(count)],
				["\x1b[<64;13;16M".repeat(count)],
				["a"],
				["日"],
				["\r"],
				["\x03"],
				["\x1b"],
			]);
		},
	);

	it("bounds an exceptional wheel to one 100-report frame without a later backlog", () => {
		wheel({ deltaY: 1e9 });
		wheel();
		expect(send.mock.calls).toEqual([["\x1b[<65;13;16M".repeat(100)], ["\x1b[<65;13;16M".repeat(6)]]);
	});

	it("keeps a reentrant physical wheel in its own frame", () => {
		terminal.element!.addEventListener("wheel", () => wheel({ deltaY: -60 }), { once: true });
		handleWheel(new WheelEvent("wheel", { deltaY: 60, clientX: 120, clientY: 150 }));
		expect(send.mock.calls).toEqual([
			["\x1b[<65;13;16M"],
			["\x1b[<64;13;16M".repeat(6)],
			["\x1b[<65;13;16M".repeat(5)],
		]);
	});

	it("preserves xterm's SGR-pixel coordinates and byte order", async () => {
		await write("\x1b[?1016h");
		wheel();
		expect(send.mock.calls).toEqual([["\x1b[<65;120;150M".repeat(6)]]);
	});

	it("preserves non-ASCII legacy mouse bytes in one binary frame", async () => {
		await write("\x1b[?1006l");
		terminal.resize(220, 220);
		wheel({ deltaY: (300 / 220) * 2, clientX: 1200, clientY: 1500 });
		// Default encoding reports are onBinary, not UTF-8 text frames.
		expect(send.mock.calls).toEqual([
			[Uint8Array.from("\x1b[M\x61\x99\xb7".repeat(2), (char) => char.charCodeAt(0))],
		]);
	});

	it("sends nothing for fractional wheel input without complete reports", () => {
		wheel({ deltaY: 4 });
		expect(send).not.toHaveBeenCalled();
		terminal.input("now");
		expect(send.mock.calls).toEqual([["now"]]);
	});

	it("flushes completed xterm reports after a dispatch exception and clears the scope", () => {
		const element = terminal.element!;
		const dispatch = element.dispatchEvent.bind(element);
		const spy = vi.spyOn(element, "dispatchEvent").mockImplementationOnce((event) => {
			dispatch(event);
			throw new Error("dispatch failed");
		});
		expect(() => handleWheel(new WheelEvent("wheel", { deltaY: 60, clientX: 120, clientY: 150 }))).toThrow(
			"dispatch failed",
		);
		spy.mockRestore();
		terminal.input("next");
		wheel();
		expect(send.mock.calls).toEqual([["\x1b[<65;13;16M"], ["next"], ["\x1b[<65;13;16M".repeat(6)]]);
	});

	it("does not merge a reentrant keyboard input into wheel reports", () => {
		terminal.element!.addEventListener("wheel", () => terminal.input("key"), { once: true });
		handleWheel(new WheelEvent("wheel", { deltaY: 60, clientX: 120, clientY: 150 }));
		expect(send.mock.calls).toEqual([["\x1b[<65;13;16M"], ["key"], ["\x1b[<65;13;16M".repeat(5)]]);
	});

	it("keeps click and modified wheel reports separate from normalized wheel frames", () => {
		wheel();
		terminal.element!.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 120, clientY: 150 }),
		);
		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 120, clientY: 150 }));
		wheel({ ctrlKey: true });
		expect(send.mock.calls).toEqual([
			["\x1b[<65;13;16M".repeat(6)],
			["\x1b[<0;13;16M"],
			["\x1b[<0;13;16m"],
			["\x1b[<81;13;16M"],
		]);
	});

	it("discards a wheel batch when the viewport is disposed during dispatch", () => {
		terminal.element!.addEventListener("wheel", () => viewport.dispose(), { once: true });
		handleWheel(new WheelEvent("wheel", { deltaY: 60, clientX: 120, clientY: 150 }));
		expect(send).not.toHaveBeenCalled();
	});

	it("keeps paste and protocol replies at their original immediate boundaries", async () => {
		wheel();
		await write("\x1b[?2004h");
		terminal.paste("first\nsecond");
		await write("\x1b[5n\x1b[6n");
		expect(send.mock.calls).toEqual([
			["\x1b[<65;13;16M".repeat(6)],
			["\x1b[200~first\rsecond\x1b[201~"],
			["\x1b[0n"],
			["\x1b[1;1R"],
		]);
	});
});
