import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyError } from "@/components/app-toaster";
import { browserHostIntegrations } from "@/runtime/browser-host-integrations";
import { TerminalBrowserInput } from "./terminal-browser-input";

vi.mock("@/components/app-toaster", () => ({ notifyError: vi.fn() }));

describe("terminal browser clipboard", () => {
	let terminal: Terminal;
	let host: HTMLDivElement;
	let input: TerminalBrowserInput;
	const writer = vi.fn(async () => {});
	const beginImagePaste = vi.fn(() => writer);
	beforeEach(() => {
		vi.clearAllMocks();
		terminal = new Terminal();
		host = document.createElement("div");
		input = new TerminalBrowserInput(terminal, host, { getSessionAgentId: () => "codex", beginImagePaste });
	});
	afterEach(() => {
		input.dispose();
		terminal.dispose();
		vi.restoreAllMocks();
	});

	function paste(files: File[]): ClipboardEvent {
		const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
		Object.defineProperty(event, "clipboardData", { value: { items: [], files } });
		host.dispatchEvent(event);
		return event;
	}

	it("claims image paste before xterm and reads the file into the captured session writer", async () => {
		const downstream = vi.fn();
		host.addEventListener("paste", downstream);
		const event = paste([new File(["image bytes"], "screen.png", { type: "image/png" })]);
		expect(event.defaultPrevented).toBe(true);
		expect(beginImagePaste).toHaveBeenCalledOnce();
		expect(downstream).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(writer).toHaveBeenCalledWith([
				expect.objectContaining({ mimeType: "image/png", data: btoa("image bytes") }),
			]),
		);
	});

	it("leaves text paste and bracketed-paste encoding to xterm", () => {
		const downstream = vi.fn();
		host.addEventListener("paste", downstream);
		expect(paste([]).defaultPrevented).toBe(false);
		expect(downstream).toHaveBeenCalledOnce();
		expect(beginImagePaste).not.toHaveBeenCalled();
	});

	it("reports image transfer failure without an unhandled rejection", async () => {
		writer.mockRejectedValueOnce(new Error("private server content"));
		paste([new File(["image"], "screen.png", { type: "image/png" })]);
		await vi.waitFor(() => expect(notifyError).toHaveBeenCalled());
		expect(JSON.stringify(vi.mocked(notifyError).mock.calls)).not.toContain("private server content");
	});

	it("reports clipboard failures and keeps the OSC parser usable", async () => {
		vi.spyOn(browserHostIntegrations, "writeClipboardText").mockRejectedValue(new Error("denied"));
		vi.spyOn(browserHostIntegrations, "readClipboardText").mockRejectedValue(new Error("denied"));
		const data = vi.fn();
		terminal.onData(data);
		await new Promise<void>((resolve) => terminal.write("\u001b]52;c;aGk=\u0007\u001b]52;c;?\u0007ok", resolve));
		expect(notifyError).toHaveBeenCalledTimes(2);
		expect(data).toHaveBeenCalledWith("\u001b]52;c;\u0007");
		expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("ok");
	});

	it("removes its DOM listener on disposal", () => {
		input.dispose();
		expect(paste([new File(["image"], "screen.png", { type: "image/png" })]).defaultPrevented).toBe(false);
		expect(beginImagePaste).not.toHaveBeenCalled();
	});
});
