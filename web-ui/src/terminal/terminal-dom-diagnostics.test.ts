import { afterEach, describe, expect, it } from "vitest";

import { collectTerminalDomDiagnostics } from "@/terminal/terminal-dom-diagnostics";

function appendHelperHost({
	parent,
	helperId = "",
	helperName = "",
}: {
	parent: HTMLElement;
	helperId?: string;
	helperName?: string;
}): HTMLTextAreaElement {
	const host = document.createElement("div");
	const xterm = document.createElement("div");
	xterm.className = "xterm";
	const helperTextarea = document.createElement("textarea");
	helperTextarea.className = "xterm-helper-textarea";
	helperTextarea.id = helperId;
	helperTextarea.name = helperName;
	xterm.appendChild(helperTextarea);
	host.appendChild(xterm);
	parent.appendChild(host);
	return helperTextarea;
}

describe("collectTerminalDomDiagnostics", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("summarizes helper textarea attributes and parking-root ownership", () => {
		const parkingRoot = document.createElement("div");
		parkingRoot.id = "kb-persistent-terminal-parking-root";
		document.body.appendChild(parkingRoot);
		appendHelperHost({ parent: parkingRoot });
		appendHelperHost({
			parent: document.body,
			helperId: "quarterdeck-terminal-input-7",
			helperName: "quarterdeck-terminal-input-7",
		});

		const diagnostics = collectTerminalDomDiagnostics();

		expect(diagnostics.helperTextareaCount).toBe(2);
		expect(diagnostics.helperTextareasMissingId).toBe(1);
		expect(diagnostics.helperTextareasMissingName).toBe(1);
		expect(diagnostics.xtermElementCount).toBe(2);
		expect(diagnostics.parkingRoot?.childElementCount).toBe(1);
		expect(diagnostics.parkingRoot?.helperTextareaCount).toBe(1);
		expect(diagnostics.parkingRoot?.children[0]?.xtermElementCount).toBe(1);
		expect(diagnostics.helperTextareas.map((helper) => helper.inParkingRoot)).toEqual([true, false]);
		expect(diagnostics.helperTextareas[0]?.parentPath).toContain("#kb-persistent-terminal-parking-root");
	});
});
