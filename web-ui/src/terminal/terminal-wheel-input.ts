import type { Terminal } from "@xterm/xterm";
import type { RuntimeAgentId } from "@/runtime/types";
import { TerminalWheelAccumulator } from "@/terminal/terminal-wheel-policy";

/** Normalize Codex distance, leaving mouse coordinates and protocol encoding to xterm. */
export class TerminalWheelInput {
	private readonly accumulator = new TerminalWheelAccumulator();
	private forwarding = false;
	private sessionKey: string | null = null;
	private buffer: Terminal["buffer"]["active"] | null = null;

	constructor(
		private readonly terminal: Terminal,
		private readonly callbacks: {
			getSessionAgentId: () => RuntimeAgentId | null;
			getConnectedTaskId: () => string | null;
		},
	) {
		terminal.attachCustomWheelEventHandler(this.onWheel);
	}

	private readonly onWheel = (event: WheelEvent): boolean => {
		if (this.forwarding) return true;
		const { terminal } = this;
		const sessionKey = this.callbacks.getConnectedTaskId();
		if (this.sessionKey !== sessionKey || this.buffer !== terminal.buffer.active) this.accumulator.reset();
		this.sessionKey = sessionKey;
		this.buffer = terminal.buffer.active;
		if (
			this.callbacks.getSessionAgentId() !== "codex" ||
			terminal.buffer.active.type !== "alternate" ||
			!["vt200", "drag", "any"].includes(terminal.modes.mouseTrackingMode) ||
			event.defaultPrevented ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey ||
			event.shiftKey ||
			event.deltaY === 0 ||
			Math.abs(event.deltaX) > Math.abs(event.deltaY)
		) {
			this.accumulator.reset();
			return true;
		}
		const element = terminal.element;
		const screen = element?.querySelector(".xterm-screen");
		const height = screen?.getBoundingClientRect().height ?? 0;
		if (!element || height <= 0) return true;
		const reports = this.accumulator.consume(event, height / terminal.rows, terminal.rows);
		this.forwarding = true;
		try {
			for (let i = 0; i < Math.abs(reports); i++) {
				// A line-mode unit avoids xterm 6's pixel heuristic and one-report-per-event truncation.
				// Re-enter its public DOM path so SGR/legacy/pixel coordinates remain xterm-owned.
				element.dispatchEvent(
					new WheelEvent("wheel", {
						bubbles: true,
						cancelable: true,
						deltaMode: WheelEvent.DOM_DELTA_LINE,
						deltaY: Math.sign(reports),
						clientX: event.clientX,
						clientY: event.clientY,
					}),
				);
			}
		} finally {
			this.forwarding = false;
		}
		return false;
	};

	dispose(): void {
		this.terminal.attachCustomWheelEventHandler(() => true);
		this.accumulator.reset();
	}
}
