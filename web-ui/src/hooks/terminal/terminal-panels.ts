/**
 * Pure domain logic for terminal panel management.
 *
 * No React imports — functions here take explicit parameters and return
 * plain data. The companion hook (`use-terminal-panels.ts`) handles React
 * state, effects, and tRPC mutations.
 */

import {
	clampAtLeast,
	readOptionalPersistedResizeNumber,
	writePersistedResizeNumber,
} from "@/resize/resize-persistence";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { getTerminalGeometry, prepareWaitForTerminalGeometry } from "@/terminal/terminal-geometry-registry";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HOME_TERMINAL_ROWS = 16;
export const APPROX_TERMINAL_CELL_WIDTH_PX = 8;
export const MIN_TERMINAL_COLS = 40;
export const MIN_BOTTOM_TERMINAL_PANE_HEIGHT = 200;
export const EXPANDED_TERMINAL_PANE_HEIGHT = 99999;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetailTerminalPanelState {
	isExpanded: boolean;
	isOpen: boolean;
}

export const DEFAULT_DETAIL_TERMINAL_PANEL_STATE: DetailTerminalPanelState = {
	isExpanded: false,
	isOpen: false,
};

// ---------------------------------------------------------------------------
// Terminal geometry estimation
// ---------------------------------------------------------------------------

/**
 * Estimate a reasonable column count for shell terminals based on the
 * browser viewport width. Falls back to 120 in SSR / headless contexts.
 */
export function estimateShellTerminalCols(): number {
	if (typeof window === "undefined") {
		return 120;
	}
	return Math.max(MIN_TERMINAL_COLS, Math.floor(Math.max(0, window.innerWidth - 96) / APPROX_TERMINAL_CELL_WIDTH_PX));
}

// ---------------------------------------------------------------------------
// Pane height persistence
// ---------------------------------------------------------------------------

/**
 * Load the persisted bottom terminal pane height from localStorage,
 * clamped to the minimum allowed height.
 */
export function loadBottomTerminalPaneHeight(): number | undefined {
	return readOptionalPersistedResizeNumber({
		key: LocalStorageKey.BottomTerminalPaneHeight,
		normalize: (value) => clampAtLeast(value, MIN_BOTTOM_TERMINAL_PANE_HEIGHT),
	});
}

/**
 * Persist the bottom terminal pane height to localStorage, returning
 * the normalized value after clamping. Returns `undefined` for non-finite inputs.
 */
export function persistBottomTerminalPaneHeight(height: number): number {
	return writePersistedResizeNumber({
		key: LocalStorageKey.BottomTerminalPaneHeight,
		value: height,
		normalize: (value) => clampAtLeast(value, MIN_BOTTOM_TERMINAL_PANE_HEIGHT),
	});
}

// ---------------------------------------------------------------------------
// Terminal geometry resolution
// ---------------------------------------------------------------------------

/**
 * Resolve terminal geometry for a shell session. Uses the existing geometry
 * if available, otherwise waits for the terminal to report its dimensions,
 * falling back to estimated values.
 */
export async function resolveShellTerminalGeometry(taskId: string): Promise<{ cols: number; rows: number }> {
	const existingGeometry = getTerminalGeometry(taskId);
	if (existingGeometry) {
		return existingGeometry;
	}
	await prepareWaitForTerminalGeometry(taskId)();
	return (
		getTerminalGeometry(taskId) ?? {
			cols: estimateShellTerminalCols(),
			rows: HOME_TERMINAL_ROWS,
		}
	);
}

// ---------------------------------------------------------------------------
// Pane height computation
// ---------------------------------------------------------------------------

/**
 * Compute the effective pane height for a terminal panel, returning the
 * expanded sentinel when expanded or the persisted height otherwise.
 */
export function computeTerminalPaneHeight(
	isExpanded: boolean,
	persistedHeight: number | undefined,
): number | undefined {
	return isExpanded ? EXPANDED_TERMINAL_PANE_HEIGHT : persistedHeight;
}

/**
 * Collapse all expanded detail terminal panels in a panel-state map.
 */
export function collapseAllDetailPanels(
	panelStateByTaskId: Record<string, DetailTerminalPanelState>,
): Record<string, DetailTerminalPanelState> {
	return Object.fromEntries(
		Object.entries(panelStateByTaskId).map(([taskId, panelState]) => [
			taskId,
			{
				...panelState,
				isExpanded: false,
			},
		]),
	);
}
