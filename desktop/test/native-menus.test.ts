import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { desktopMenuTemplate } from "../src/native-menus.js";

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
	return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])]);
}

describe("native menus", () => {
	it("routes Settings once without synthesizing a renderer keyboard event", () => {
		const dispatch = vi.fn();
		const template = desktopMenuTemplate({
			appName: "Quarterdeck",
			productReady: true,
			availableCommands: ["settings"],
			updatesAvailable: false,
			updatePending: false,
			dispatch,
			openInBrowser: vi.fn(),
			checkForUpdates: vi.fn(),
			restartToUpdate: vi.fn(),
			reloadWindow: vi.fn(),
		});
		const settings = items(template).find((item) => item.id === "desktop.settings");
		expect(settings?.accelerator).toBe("Cmd+,");
		settings?.click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as Electron.KeyboardEvent);
		expect(dispatch).toHaveBeenCalledExactlyOnceWith("settings");
	});
	it("defaults to disabled until publication and preserves only published offline recovery commands", () => {
		const base = {
			appName: "Quarterdeck",
			productReady: true,
			updatesAvailable: false,
			updatePending: false,
			dispatch: vi.fn(),
			openInBrowser: vi.fn(),
			checkForUpdates: vi.fn(),
			restartToUpdate: vi.fn(),
			reloadWindow: vi.fn(),
		};
		expect(items(desktopMenuTemplate(base)).find((item) => item.id === "desktop.settings")?.enabled).toBe(false);
		const offline = items(
			desktopMenuTemplate({ ...base, availableCommands: ["settings", "diagnostics"], runtimeConnected: false }),
		);
		expect(offline.find((item) => item.id === "desktop.settings")?.enabled).toBe(true);
		expect(offline.find((item) => item.id === "desktop.newTask")?.enabled).toBe(false);
		expect(offline.find((item) => item.id === "desktop.openInBrowser")?.enabled).toBe(false);
	});

	it("keeps product actions unavailable on startup and omits unchecked reload/devtools roles", () => {
		const template = desktopMenuTemplate({
			appName: "Quarterdeck",
			productReady: false,
			updatesAvailable: false,
			updatePending: false,
			dispatch: vi.fn(),
			openInBrowser: vi.fn(),
			checkForUpdates: vi.fn(),
			restartToUpdate: vi.fn(),
			reloadWindow: vi.fn(),
		});
		const flattened = items(template);
		expect(flattened.find((item) => item.id === "desktop.newTask")?.enabled).toBe(false);
		expect(flattened.find((item) => item.id === "desktop.checkUpdates")?.enabled).toBe(false);
		expect(
			flattened.some(
				(item) => item.role === "reload" || item.role === "forceReload" || item.role === "toggleDevTools",
			),
		).toBe(false);
		expect(flattened.filter((item) => item.accelerator === "Cmd+,")).toHaveLength(1);
		expect(flattened.filter((item) => item.accelerator === "Cmd+J")).toHaveLength(1);
		expect(flattened.find((item) => item.role === "minimize")).toBeDefined();
	});
});
