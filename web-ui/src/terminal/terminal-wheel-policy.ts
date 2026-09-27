// Codex's fullscreen transcript advances three rows per wheel report.
const CODEX_WHEEL_ROWS_PER_REPORT = 3;
const MAX_REPORTS_PER_EVENT = 100;
// Chromium transports wheel deltas as float32; tolerate sub-pixel rounding at a report boundary.
const ROUNDING_EPSILON = 1e-6;

/** Convert browser distance to discrete reports without depending on event frequency. */
export class TerminalWheelAccumulator {
	private remainder = 0;

	reset(): void {
		this.remainder = 0;
	}

	consume(event: Pick<WheelEvent, "deltaY" | "deltaMode">, cellHeight: number, rows: number): number {
		const { deltaY, deltaMode } = event;
		if (!Number.isFinite(deltaY) || cellHeight <= 0 || !Number.isFinite(cellHeight)) return 0;
		if (deltaY === 0) return 0;
		if (Math.sign(deltaY) !== Math.sign(this.remainder)) {
			this.remainder = 0;
		}
		const distance = deltaMode === 0 ? deltaY / cellHeight : deltaMode === 1 ? deltaY : deltaY * rows;
		const reports = this.remainder + distance / CODEX_WHEEL_ROWS_PER_REPORT;
		const whole = Math.trunc(reports + Math.sign(reports) * ROUNDING_EPSILON);
		this.remainder = Math.abs(reports - whole) < ROUNDING_EPSILON ? 0 : reports - whole;
		// Bound synchronous dispatch for pathological device deltas; never queue stale wheel input.
		return Math.max(-MAX_REPORTS_PER_EVENT, Math.min(MAX_REPORTS_PER_EVENT, whole)) || 0;
	}
}
