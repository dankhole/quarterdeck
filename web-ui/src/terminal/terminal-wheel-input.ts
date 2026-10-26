import type { IDisposable, Terminal } from "@xterm/xterm";
import type { RuntimeAgentId } from "@/runtime/types";
import { TerminalWheelAccumulator } from "@/terminal/terminal-wheel-policy";

/** Normalize fullscreen Codex/Pi distance; xterm owns mouse coordinates and encoding. */
export class TerminalWheelInput {
	private readonly accumulator = new TerminalWheelAccumulator();
	private readonly forwardedEvents = new WeakSet<WheelEvent>();
	private disposed = false;
	private sessionKey: string | null = null;
	private agentId: RuntimeAgentId | null = null;
	private readonly bufferChangeSubscription: IDisposable;

	constructor(
		private readonly terminal: Terminal,
		private readonly callbacks: {
			getSessionAgentId: () => RuntimeAgentId | null;
			getConnectedTaskId: () => string | null;
			batchWheelReports?: (dispatch: () => void) => void;
		},
	) {
		// A subprocess may leave and re-enter the same alternate buffer between wheel events.
		this.bufferChangeSubscription = terminal.buffer.onBufferChange(() => this.accumulator.reset());
		terminal.attachCustomWheelEventHandler(this.onWheel);
	}

	private readonly onWheel = (event: WheelEvent): boolean => {
		if (this.disposed || this.forwardedEvents.has(event)) return true;
		const { terminal } = this;
		const sessionKey = this.callbacks.getConnectedTaskId();
		const agentId = this.callbacks.getSessionAgentId();
		if (this.sessionKey !== sessionKey || this.agentId !== agentId) this.accumulator.reset();
		this.sessionKey = sessionKey;
		this.agentId = agentId;
		if (
			(agentId !== "codex" && agentId !== "pi") ||
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
		if (
			!element ||
			!Number.isFinite(height) ||
			height <= 0 ||
			!Number.isFinite(terminal.rows) ||
			terminal.rows <= 0
		) {
			this.accumulator.reset();
			return true;
		}
		// Codex advances three rows/report. Pi's local macOS auto mode expects
		// one report per browser row; its native wheel setting remains a multiplier.
		const reports = this.accumulator.consume(event, height / terminal.rows, terminal.rows, agentId === "pi" ? 1 : 3);
		const dispatch = (): void => {
			for (let i = 0; i < Math.abs(reports) && !this.disposed; i++) {
				// A line-mode unit avoids xterm 6's pixel heuristic and one-report-per-event truncation.
				// Re-enter its public DOM path so SGR/legacy/pixel coordinates remain xterm-owned.
				const forwarded = new WheelEvent("wheel", {
					bubbles: true,
					cancelable: true,
					deltaMode: WheelEvent.DOM_DELTA_LINE,
					deltaY: Math.sign(reports),
					clientX: event.clientX,
					clientY: event.clientY,
				});
				this.forwardedEvents.add(forwarded);
				try {
					element.dispatchEvent(forwarded);
				} finally {
					this.forwardedEvents.delete(forwarded);
				}
			}
		};
		if (this.callbacks.batchWheelReports) this.callbacks.batchWheelReports(dispatch);
		else dispatch();
		return false;
	};

	dispose(): void {
		this.disposed = true;
		this.bufferChangeSubscription.dispose();
		this.terminal.attachCustomWheelEventHandler(() => true);
		this.accumulator.reset();
	}
}
