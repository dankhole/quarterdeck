import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { type BrowserWindow, screen } from "electron";
import { clampWindowBounds, type DesktopWindowState, parseWindowState } from "./window-geometry.js";

export function readWindowState(path: string): DesktopWindowState | null {
	try {
		if (statSync(path).size > 8192) return null;
		return parseWindowState(JSON.parse(readFileSync(path, "utf8")) as unknown);
	} catch {
		return null;
	}
}

export function restoreWindowState(window: BrowserWindow, state: DesktopWindowState | null): void {
	if (!state) return;
	window.setBounds(
		clampWindowBounds(
			state.bounds,
			screen.getAllDisplays().map((display) => display.workArea),
			screen.getPrimaryDisplay().workArea,
		),
	);
	if (state.maximized) window.maximize();
	if (state.fullscreen) window.setFullScreen(true);
}

/** Capture normal geometry, and persist only when hiding/quitting instead of on every drag event. */
export function installWindowState(window: BrowserWindow, path: string): () => void {
	const save = (): void => {
		if (window.isDestroyed()) return;
		const state: DesktopWindowState = {
			version: 1,
			bounds: window.getNormalBounds(),
			maximized: window.isMaximized(),
			fullscreen: window.isFullScreen(),
		};
		try {
			writeFileSync(`${path}.${process.pid}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
			renameSync(`${path}.${process.pid}.tmp`, path);
		} catch {
			// Window preferences are presentation only and cannot prevent task shutdown.
		}
	};
	const clamp = (): void => {
		if (!window.isDestroyed() && !window.isFullScreen() && !window.isMaximized()) {
			window.setBounds(
				clampWindowBounds(
					window.getBounds(),
					screen.getAllDisplays().map((display) => display.workArea),
					screen.getPrimaryDisplay().workArea,
				),
			);
		}
	};
	window.on("close", save);
	screen.on("display-removed", clamp);
	screen.on("display-metrics-changed", clamp);
	window.once("closed", () => {
		screen.off("display-removed", clamp);
		screen.off("display-metrics-changed", clamp);
	});
	return save;
}
