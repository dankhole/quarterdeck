import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeClipboardText } from "@/components/git/panels/context-menu-utils";

vi.mock("@/components/app-toaster", () => ({
	showAppToast: vi.fn(),
}));

describe("writeClipboardText", () => {
	let originalClipboard: Clipboard | undefined;
	let originalExecCommand: Document["execCommand"] | undefined;

	beforeEach(() => {
		originalClipboard = navigator.clipboard;
		originalExecCommand = document.execCommand;
		document.body.innerHTML = "";
	});

	afterEach(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: originalClipboard,
		});
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: originalExecCommand,
		});
		document.getSelection()?.removeAllRanges();
		document.body.innerHTML = "";
	});

	it("uses navigator.clipboard when available", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		const execCommand = vi.fn().mockReturnValue(true);
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: execCommand,
		});

		await writeClipboardText("copied text");

		expect(writeText).toHaveBeenCalledWith("copied text");
		expect(execCommand).not.toHaveBeenCalled();
	});

	it("falls back to a temporary textarea and restores focus and selection", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		const execCommand = vi.fn().mockReturnValue(true);
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: execCommand,
		});
		const input = document.createElement("input");
		const selectedText = document.createElement("p");
		selectedText.textContent = "selected text";
		document.body.append(input, selectedText);
		input.focus();
		const range = document.createRange();
		const textNode = selectedText.firstChild;
		if (!textNode) {
			throw new Error("Expected text node.");
		}
		range.setStart(textNode, 0);
		range.setEnd(textNode, "selected".length);
		const selection = document.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		await writeClipboardText("fallback text");

		expect(writeText).toHaveBeenCalledWith("fallback text");
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(document.activeElement).toBe(input);
		expect(document.querySelector("textarea")).toBeNull();
		expect(document.getSelection()?.toString()).toBe("selected");
	});
});
