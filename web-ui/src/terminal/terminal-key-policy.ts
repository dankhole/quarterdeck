import type { RuntimeAgentId } from "@/runtime/types";

export interface TerminalKeyContext {
	isMac: boolean;
	agentId: RuntimeAgentId | null;
	hasSelection: boolean;
	alternateScreen: boolean;
	mouseTracking: boolean;
}

export type TerminalKeyAction =
	| { kind: "pass" }
	| { kind: "consume" }
	| { kind: "copy" }
	| { kind: "send"; data: string };

// Host editing conventions, deliberately separate from provider protocol support.
const MAC_EDITING_KEYS: Readonly<Record<string, string>> = {
	ArrowLeft: "\u0001",
	ArrowRight: "\u0005",
	Backspace: "\u0015",
};

export function resolveTerminalKey(event: KeyboardEvent, context: TerminalKeyContext): TerminalKeyAction {
	if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return { kind: "pass" };
	let data: string | undefined;
	if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
		data = "\n";
	} else if (context.isMac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
		data = MAC_EDITING_KEYS[event.key];
	}
	if (data !== undefined) {
		return event.type === "keydown" ? { kind: "send", data } : { kind: "consume" };
	}
	if (event.type !== "keydown" || event.altKey || event.key.toLowerCase() !== "c") return { kind: "pass" };
	// Windows Ctrl+C copies a local selection, but otherwise remains an interrupt.
	// A provider-owned selection does not qualify and must not change those bytes.
	const copy = context.isMac
		? event.metaKey && !event.ctrlKey && !event.shiftKey
		: event.ctrlKey && !event.metaKey && (event.shiftKey || context.hasSelection);
	if (!copy) return { kind: "pass" };
	if (context.hasSelection) return { kind: "copy" };
	if (context.agentId === "codex" && context.alternateScreen && context.mouseTracking) {
		// Codex accepts Kitty Super+C and Ctrl+Shift+C. Never degrade to Ctrl+C:
		// without a provider selection that is an interrupt, not a copy operation.
		return { kind: "send", data: context.isMac ? "\u001b[99;9u" : "\u001b[99;6u" };
	}
	return { kind: "pass" };
}
