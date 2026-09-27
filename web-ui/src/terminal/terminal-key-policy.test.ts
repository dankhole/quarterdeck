import { describe, expect, it } from "vitest";
import { resolveTerminalKey, type TerminalKeyContext } from "./terminal-key-policy";

const context: TerminalKeyContext = {
	isMac: true,
	agentId: "codex",
	hasSelection: false,
	alternateScreen: true,
	mouseTracking: true,
};

describe("terminal key policy", () => {
	it.each([
		["ArrowLeft", "\u0001"],
		["ArrowRight", "\u0005"],
		["Backspace", "\u0015"],
	])("maps macOS Command+%s to the terminal editing convention once", (key, data) => {
		for (const type of ["keydown", "keypress", "keyup"]) {
			expect(resolveTerminalKey(new KeyboardEvent(type, { key, metaKey: true }), context)).toEqual(
				type === "keydown" ? { kind: "send", data } : { kind: "consume" },
			);
		}
		expect(
			resolveTerminalKey(new KeyboardEvent("keydown", { key, metaKey: true }), { ...context, isMac: false }),
		).toEqual({ kind: "pass" });
	});

	it.each<KeyboardEventInit>([
		{ key: "Enter", shiftKey: true, ctrlKey: true },
		{ key: "Enter", shiftKey: true, altKey: true },
		{ key: "Enter", shiftKey: true, metaKey: true },
		{ key: "Enter", shiftKey: true, isComposing: true },
		{ key: "Enter", shiftKey: true, keyCode: 229 },
		{ key: "ArrowLeft", metaKey: true, shiftKey: true },
		{ key: "Backspace", metaKey: true, altKey: true },
		{ key: "c", ctrlKey: true },
		{ key: "v", metaKey: true },
		{ key: "ArrowLeft", altKey: true },
	])("preserves composition, other modifiers, interrupt, and native paste: %j", (init) => {
		expect(resolveTerminalKey(new KeyboardEvent("keydown", init), context)).toEqual({ kind: "pass" });
	});

	it("does not re-handle an event already claimed by another owner", () => {
		const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true });
		event.preventDefault();
		expect(resolveTerminalKey(event, context)).toEqual({ kind: "pass" });
	});
});
