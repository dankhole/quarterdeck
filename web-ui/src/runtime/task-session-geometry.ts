const HORIZONTAL_CHROME_PX = 96;
const APPROX_TERMINAL_CELL_WIDTH_PX = 8;
const APPROX_TERMINAL_CELL_HEIGHT_PX = 16;
const APP_TOP_BAR_HEIGHT_PX = 40;
const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 12;
const MAX_ESTIMATED_TERMINAL_COLS = 160;

export interface TaskSessionGeometry {
	cols: number;
	rows: number;
}

export function estimateTaskSessionGeometry(viewportWidth: number, viewportHeight: number): TaskSessionGeometry {
	const safeViewportWidth = Math.max(0, viewportWidth);
	const safeViewportHeight = Math.max(0, viewportHeight - APP_TOP_BAR_HEIGHT_PX);
	const terminalWidthPx = Math.max(0, safeViewportWidth - HORIZONTAL_CHROME_PX);
	const estimatedCols = Math.max(MIN_TERMINAL_COLS, Math.floor(terminalWidthPx / APPROX_TERMINAL_CELL_WIDTH_PX));

	return {
		cols: Math.min(MAX_ESTIMATED_TERMINAL_COLS, estimatedCols),
		rows: Math.max(MIN_TERMINAL_ROWS, Math.floor(safeViewportHeight / APPROX_TERMINAL_CELL_HEIGHT_PX)),
	};
}
