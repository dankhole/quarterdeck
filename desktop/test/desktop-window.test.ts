import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDesktopWindow } from "../src/desktop-window.js";

vi.mock("electron", () => ({
	BrowserWindow: class extends EventEmitter {
		webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
	},
	shell: { openExternal: vi.fn() },
}));

describe("trusted startup surface navigation", () => {
	it("passes the exact originating renderer for a main-frame recovery action", () => {
		const onSurfaceAction = vi.fn();
		const renderer = createDesktopWindow({
			partition: "synthetic",
			preloadPath: "/synthetic/preload.cjs",
			isQuitting: () => false,
			isSynthetic: true,
			showWindow: false,
			onSurfaceAction,
			onRendererFailed: vi.fn(),
		});
		const event = { url: "app://quarterdeck/__desktop/recover", isMainFrame: true, preventDefault: vi.fn() };
		renderer.contents.emit("will-frame-navigate", event);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(onSurfaceAction).toHaveBeenCalledExactlyOnceWith("recover", renderer);
	});

	it("rejects subframes and action arguments before reaching main", () => {
		const onSurfaceAction = vi.fn();
		const renderer = createDesktopWindow({
			partition: "synthetic",
			preloadPath: "/synthetic/preload.cjs",
			isQuitting: () => false,
			isSynthetic: true,
			showWindow: false,
			onSurfaceAction,
			onRendererFailed: vi.fn(),
		});
		for (const event of [
			{ url: "app://quarterdeck/__desktop/recover", isMainFrame: false, preventDefault: vi.fn() },
			{ url: "app://quarterdeck/__desktop/recover?command=anything", isMainFrame: true, preventDefault: vi.fn() },
			{ url: "app://quarterdeck/__desktop/recover#confirmed", isMainFrame: true, preventDefault: vi.fn() },
		]) {
			renderer.contents.emit("will-frame-navigate", event);
			expect(event.preventDefault).toHaveBeenCalledOnce();
		}
		expect(onSurfaceAction).not.toHaveBeenCalled();
	});
});
