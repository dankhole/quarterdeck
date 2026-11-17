import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDesktopWindow } from "../src/desktop-window.js";

const windows = vi.hoisted(() => [] as Array<EventEmitter & { hide: ReturnType<typeof vi.fn> }>);

vi.mock("electron", () => ({
	BrowserWindow: class extends EventEmitter {
		webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
		hide = vi.fn();
		constructor() {
			super();
			windows.push(this);
		}
	},
	shell: { openExternal: vi.fn() },
}));

describe("trusted startup surface navigation", () => {
	it("routes a Windows close through guarded quit and permits destruction after confirmation", () => {
		let quitting = false;
		const onQuitRequested = vi.fn();
		createDesktopWindow({
			partition: "synthetic",
			preloadPath: "/synthetic/preload.cjs",
			isQuitting: () => quitting,
			isSynthetic: true,
			showWindow: false,
			closeBehavior: "quit",
			onQuitRequested,
			onSurfaceAction: vi.fn(),
			onRendererFailed: vi.fn(),
		});
		const window = windows.at(-1);
		if (!window) throw new Error("Desktop window was not constructed.");
		const event = { preventDefault: vi.fn() };
		window.emit("close", event);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(onQuitRequested).toHaveBeenCalledOnce();
		expect(window.hide).not.toHaveBeenCalled();
		quitting = true;
		const confirmed = { preventDefault: vi.fn() };
		window.emit("close", confirmed);
		expect(confirmed.preventDefault).not.toHaveBeenCalled();
		expect(onQuitRequested).toHaveBeenCalledOnce();
	});
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
