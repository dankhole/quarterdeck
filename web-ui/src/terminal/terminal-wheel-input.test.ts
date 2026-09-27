import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAgentId } from "@/runtime/types";
import { TerminalWheelInput } from "./terminal-wheel-input";

describe("Codex wheel input adapter", () => {
	let terminal: Terminal;
	let input: TerminalWheelInput;
	let handleWheel: (event: WheelEvent) => boolean;
	let agentId: RuntimeAgentId | null;
	let taskId: string;
	let element: HTMLDivElement;
	const reports = vi.fn();
	beforeEach(async () => {
		agentId = "codex";
		taskId = "task";
		reports.mockClear();
		terminal = new Terminal({ rows: 30 });
		element = document.createElement("div");
		const screen = document.createElement("div");
		screen.className = "xterm-screen";
		element.append(screen);
		vi.spyOn(screen, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 300));
		vi.spyOn(terminal, "element", "get").mockReturnValue(element);
		vi.spyOn(terminal, "attachCustomWheelEventHandler").mockImplementation((handler) => {
			handleWheel = handler;
		});
		input = new TerminalWheelInput(terminal, { getSessionAgentId: () => agentId, getConnectedTaskId: () => taskId });
		element.addEventListener("wheel", (event) => {
			// Re-entrant dispatch must pass through to xterm exactly once per normalized report.
			if (handleWheel(event)) reports(event.deltaY, event.deltaMode, event.clientX, event.clientY);
		});
		await write("\u001b[?1049h\u001b[?1002h\u001b[?1006h");
	});
	afterEach(() => {
		input.dispose();
		terminal.dispose();
		vi.restoreAllMocks();
	});
	function write(data: string): Promise<void> {
		return new Promise((resolve) => terminal.write(data, resolve));
	}
	function wheel(init: WheelEventInit = {}): boolean {
		return handleWheel(new WheelEvent("wheel", { deltaY: 60, clientX: 120, clientY: 150, ...init }));
	}
	it("expands a large pixel delta at the original coordinates without duplicate handling", () => {
		expect(wheel()).toBe(false);
		expect(reports.mock.calls).toEqual([
			[1, 1, 120, 150],
			[1, 1, 120, 150],
		]);
	});
	it.each<RuntimeAgentId | null>(["claude", "pi", null])("leaves %s with xterm", (agent) => {
		agentId = agent;
		expect(wheel()).toBe(true);
		expect(reports).not.toHaveBeenCalled();
	});
	it.each(["\u001b[?1049l", "\u001b[?1002l", "\u001b[?9h"])("leaves non-wheel mode %j with xterm", async (mode) => {
		await write(mode);
		expect(wheel()).toBe(true);
		expect(reports).not.toHaveBeenCalled();
	});
	it.each<WheelEventInit>([
		{ ctrlKey: true },
		{ altKey: true },
		{ metaKey: true },
		{ shiftKey: true },
		{ deltaY: 0 },
		{ deltaX: 80 },
	])("preserves modified/horizontal input %j", (event) => {
		expect(wheel(event)).toBe(true);
		expect(reports).not.toHaveBeenCalled();
	});
	it("does not carry fractional motion to another task", () => {
		wheel({ deltaY: 20 });
		taskId = "other";
		wheel({ deltaY: 10 });
		expect(reports).not.toHaveBeenCalled();
	});
	it("restores ordinary xterm handling on disposal", () => {
		input.dispose();
		expect(wheel()).toBe(true);
		expect(reports).not.toHaveBeenCalled();
	});
});
