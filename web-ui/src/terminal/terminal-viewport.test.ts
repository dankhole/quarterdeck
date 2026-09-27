import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserHostIntegrations } from "@/runtime/browser-host-integrations";
import type { RuntimeAgentId } from "@/runtime/types";
import { SlotRenderer } from "@/terminal/slot-renderer";
import { TerminalViewport } from "@/terminal/terminal-viewport";

const platform = vi.hoisted(() => ({ isMac: true }));
vi.mock("@/utils/platform", () => ({
	get isMacPlatform() {
		return platform.isMac;
	},
}));

describe("TerminalViewport copy keys", () => {
	let viewport: TerminalViewport;
	let terminal: Terminal;
	let handleKey: (event: KeyboardEvent) => boolean;
	let agentId: RuntimeAgentId | null;
	const sendIoData = vi.fn(() => true);
	const copyText = vi.fn(async () => {});

	beforeEach(async () => {
		platform.isMac = true;
		agentId = "codex";
		sendIoData.mockClear();
		copyText.mockClear();
		// Keep the real parser, input events, modes and clipboard addon; only skip rendering.
		vi.spyOn(SlotRenderer.prototype, "openWhenFontsReady").mockImplementation(() => {});
		vi.spyOn(Terminal.prototype, "attachCustomKeyEventHandler").mockImplementation(function (
			this: Terminal,
			handler,
		) {
			terminal = this;
			handleKey = handler;
		});
		vi.spyOn(browserHostIntegrations, "writeClipboardText").mockImplementation(copyText);
		viewport = new TerminalViewport(
			1,
			{ cursorColor: "#ffffff", terminalBackgroundColor: "#000000" },
			{
				clearGeometry: vi.fn(),
				getConnectedTaskId: () => "task-copy",
				getSessionAgentId: () => agentId,
				beginImagePaste: () => null,
				isDisposed: () => false,
				notifyOutputText: vi.fn(),
				reportGeometry: vi.fn(),
				sendControlMessage: () => true,
				sendIoData,
			},
		);
		await write("\u001b[?1049h\u001b[?1002h");
	});

	afterEach(() => {
		viewport.dispose();
		vi.restoreAllMocks();
	});

	function write(text: string): Promise<void> {
		return new Promise((resolve) => terminal.write(text, resolve));
	}

	function copyKey(init: KeyboardEventInit = {}, type = "keydown"): KeyboardEvent {
		return new KeyboardEvent(type, { key: "c", metaKey: true, cancelable: true, ...init });
	}

	it("forwards Command+C as Super+C when Codex owns fullscreen selection", () => {
		const event = copyKey();
		expect(handleKey(event)).toBe(false);
		expect(event.defaultPrevented).toBe(true);
		expect(sendIoData.mock.calls).toEqual([["\u001b[99;9u"]]);
		expect(copyText).not.toHaveBeenCalled();
	});

	it("copies the terminal selection before considering Codex's selection", () => {
		vi.spyOn(terminal, "hasSelection").mockReturnValue(true);
		vi.spyOn(terminal, "getSelection").mockReturnValue("selected terminal text");
		expect(handleKey(copyKey())).toBe(false);
		expect(copyText).toHaveBeenCalledWith("selected terminal text");
		expect(sendIoData).not.toHaveBeenCalled();
	});

	it.each<RuntimeAgentId | null>(["claude", "pi", null])("does not forward Command+C to %s", (id) => {
		agentId = id;
		expect(handleKey(copyKey())).toBe(true);
		expect(sendIoData).not.toHaveBeenCalled();
	});

	it.each(["\u001b[?1049l", "\u001b[?1002l"])("stops forwarding after Codex disables %j", async (sequence) => {
		await write(sequence);
		expect(handleKey(copyKey())).toBe(true);
		expect(sendIoData).not.toHaveBeenCalled();
	});

	it.each(["keypress", "keyup"])("does not duplicate copy on %s", (type) => {
		expect(handleKey(copyKey({}, type))).toBe(true);
		expect(sendIoData).not.toHaveBeenCalled();
	});

	it.each<KeyboardEventInit>([
		{ metaKey: false, ctrlKey: true },
		{ ctrlKey: true },
		{ altKey: true },
		{ shiftKey: true },
		{ metaKey: false },
	])("leaves other C shortcuts to xterm: %j", (modifiers) => {
		expect(handleKey(copyKey(modifiers))).toBe(true);
		expect(sendIoData).not.toHaveBeenCalled();
		expect(copyText).not.toHaveBeenCalled();
	});

	it("preserves Ctrl+Shift+C terminal copy on other platforms", () => {
		platform.isMac = false;
		vi.spyOn(terminal, "hasSelection").mockReturnValue(true);
		vi.spyOn(terminal, "getSelection").mockReturnValue("selected terminal text");
		expect(handleKey(copyKey({ metaKey: false, ctrlKey: true, shiftKey: true }))).toBe(false);
		expect(copyText).toHaveBeenCalledWith("selected terminal text");
		expect(sendIoData).not.toHaveBeenCalled();
	});

	it("sends Ctrl+Shift+C to Codex on other platforms without a terminal selection", () => {
		platform.isMac = false;
		expect(handleKey(copyKey({ metaKey: false, ctrlKey: true, shiftKey: true }))).toBe(false);
		expect(handleKey(copyKey())).toBe(true);
		expect(sendIoData.mock.calls).toEqual([["\u001b[99;6u"]]);
	});

	it("delivers the provider's OSC 52 copy through the clipboard integration", async () => {
		await write("\u001b]52;c;c2VsZWN0ZWQgdGV4dA==\u0007");
		expect(copyText).toHaveBeenCalledWith("selected text");
	});

	it("still sends a single newline for Shift+Enter", () => {
		for (const type of ["keydown", "keypress", "keyup"]) {
			expect(handleKey(new KeyboardEvent(type, { key: "Enter", shiftKey: true }))).toBe(false);
		}
		expect(sendIoData.mock.calls).toEqual([["\n"]]);
	});
});
