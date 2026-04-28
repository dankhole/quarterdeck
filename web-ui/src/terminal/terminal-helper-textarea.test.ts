import { describe, expect, it } from "vitest";

import { applyTerminalInputFieldAttributes } from "@/terminal/terminal-helper-textarea";

describe("applyTerminalInputFieldAttributes", () => {
	it("adds stable id and name attributes to xterm's generated input helper", () => {
		const hostElement = document.createElement("div");
		const helperTextarea = document.createElement("textarea");
		helperTextarea.className = "xterm-helper-textarea";
		hostElement.appendChild(helperTextarea);

		applyTerminalInputFieldAttributes(hostElement, 7);

		expect(helperTextarea.id).toBe("quarterdeck-terminal-input-7");
		expect(helperTextarea.name).toBe("quarterdeck-terminal-input-7");
	});

	it("leaves unrelated hosts unchanged", () => {
		const hostElement = document.createElement("div");

		expect(() => applyTerminalInputFieldAttributes(hostElement, 7)).not.toThrow();
		expect(hostElement.children).toHaveLength(0);
	});

	it("preserves existing helper attributes", () => {
		const hostElement = document.createElement("div");
		const helperTextarea = document.createElement("textarea");
		helperTextarea.className = "xterm-helper-textarea";
		helperTextarea.id = "existing-id";
		helperTextarea.name = "existing-name";
		hostElement.appendChild(helperTextarea);

		applyTerminalInputFieldAttributes(hostElement, 7);

		expect(helperTextarea.id).toBe("existing-id");
		expect(helperTextarea.name).toBe("existing-name");
	});
});
