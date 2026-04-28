const XTERM_HELPER_TEXTAREA_SELECTOR = "textarea.xterm-helper-textarea";

export function applyTerminalInputFieldAttributes(hostElement: HTMLElement, slotId: number): void {
	const helperTextarea = hostElement.querySelector<HTMLTextAreaElement>(XTERM_HELPER_TEXTAREA_SELECTOR);
	if (!helperTextarea) {
		return;
	}

	const fieldName = `quarterdeck-terminal-input-${slotId}`;
	if (!helperTextarea.id) {
		helperTextarea.id = fieldName;
	}
	if (!helperTextarea.name) {
		helperTextarea.name = helperTextarea.id || fieldName;
	}
}
