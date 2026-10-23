import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { desktopMenuTemplate } from "../src/native-menus.js";

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
	return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])]);
}

describe("native menus", () => {
	it("shows checked availability and blocks the item during update coordination", () => {
		const actions = {
			appName: "Quarterdeck",
			productReady: true,
			updateGuidanceAvailable: true,
			updateLabel: "Update available · v0.12.9…",
			dispatch: vi.fn(),
			openInBrowser: vi.fn(),
			showUpdateGuidance: vi.fn(),
			reloadWindow: vi.fn(),
		};
		expect(items(desktopMenuTemplate(actions)).find((item) => item.id === "desktop.updateGuidance")).toMatchObject({
			label: "Update available · v0.12.9…",
			enabled: true,
		});
		expect(
			items(desktopMenuTemplate({ ...actions, updateBusy: true })).find(
				(item) => item.id === "desktop.updateGuidance",
			)?.enabled,
		).toBe(false);
	});
	it("opens owner update guidance without download or restart actions", () => {
		const showUpdateGuidance = vi.fn();
		const template = desktopMenuTemplate({
			appName: "Quarterdeck",
			productReady: false,
			updateGuidanceAvailable: true,
			dispatch: vi.fn(),
			openInBrowser: vi.fn(),
			showUpdateGuidance,
			reloadWindow: vi.fn(),
		});
		const flattened = items(template);
		const update = flattened.find((item) => item.id === "desktop.updateGuidance");
		expect(update?.enabled).toBe(true);
		expect(update?.label).toBe("Update Quarterdeck…");
		update?.click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as Electron.KeyboardEvent);
		expect(showUpdateGuidance).toHaveBeenCalledOnce();
		expect(flattened.some((item) => item.id === "desktop.checkUpdates" || item.id === "desktop.restartUpdate")).toBe(
			false,
		);
	});
	it("routes Settings once without synthesizing a renderer keyboard event", () => {
		const dispatch = vi.fn();
		const template = desktopMenuTemplate({
			appName: "Quarterdeck",
			productReady: true,
			availableCommands: ["settings"],
			updateGuidanceAvailable: false,
			dispatch,
			openInBrowser: vi.fn(),
			showUpdateGuidance: vi.fn(),
			reloadWindow: vi.fn(),
		});
		const settings = items(template).find((item) => item.id === "desktop.settings");
		expect(settings?.accelerator).toBe("Cmd+,");
		settings?.click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as Electron.KeyboardEvent);
		expect(dispatch).toHaveBeenCalledExactlyOnceWith("settings");
		expect(items(template).some((item) => item.id === "desktop.environment")).toBe(false);
	});
	it("defaults to disabled until publication and preserves only published offline recovery commands", () => {
		const base = {
			appName: "Quarterdeck",
			productReady: true,
			updateGuidanceAvailable: false,
			dispatch: vi.fn(),
			openInBrowser: vi.fn(),
			showUpdateGuidance: vi.fn(),
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
			updateGuidanceAvailable: false,
			dispatch: vi.fn(),
			openInBrowser: vi.fn(),
			showUpdateGuidance: vi.fn(),
			reloadWindow: vi.fn(),
		});
		const flattened = items(template);
		expect(flattened.find((item) => item.id === "desktop.newTask")?.enabled).toBe(false);
		expect(flattened.find((item) => item.id === "desktop.updateGuidance")?.enabled).toBe(false);
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
