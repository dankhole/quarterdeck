const MAX_REPORTS_PER_EVENT = 100;
// Chromium transports wheel deltas as float32; tolerate sub-pixel rounding at a report boundary.
const ROUNDING_EPSILON = 1e-6;

/** Convert browser distance to discrete reports without depending on event frequency. */
export class TerminalWheelAccumulator {
	private remainder = 0;

	reset(): void {
		this.remainder = 0;
	}

	consume(
		event: Pick<WheelEvent, "deltaY" | "deltaMode">,
		cellHeight: number,
		rows: number,
		rowsPerReport: number,
	): number {
		const { deltaY, deltaMode } = event;
		if (
			!Number.isFinite(deltaY) ||
			cellHeight <= 0 ||
			!Number.isFinite(cellHeight) ||
			rows <= 0 ||
			!Number.isFinite(rows) ||
			rowsPerReport <= 0 ||
			!Number.isFinite(rowsPerReport)
		)
			return 0;
		if (deltaY === 0) return 0;
		if (Math.sign(deltaY) !== Math.sign(this.remainder)) {
			this.remainder = 0;
		}
		const distance = deltaMode === 0 ? deltaY / cellHeight : deltaMode === 1 ? deltaY : deltaY * rows;
		const reports = this.remainder + distance / rowsPerReport;
		const whole = Math.trunc(reports + Math.sign(reports) * ROUNDING_EPSILON);
		this.remainder = Math.abs(reports - whole) < ROUNDING_EPSILON ? 0 : reports - whole;
		// Bound synchronous dispatch for pathological device deltas; never queue stale wheel input.
		return Math.max(-MAX_REPORTS_PER_EVENT, Math.min(MAX_REPORTS_PER_EVENT, whole)) || 0;
	}
}
