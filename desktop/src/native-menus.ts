import type { MenuItemConstructorOptions } from "electron";
import type { DesktopAppCommand } from "../../src/shared/desktop-bridge-contract.js";

export interface DesktopMenuActions {
	platform?: NodeJS.Platform;
	appName: string;
	productReady: boolean;
	availableCommands?: readonly DesktopAppCommand["command"][];
	runtimeConnected?: boolean;
	updateGuidanceAvailable: boolean;
	updateLabel?: string;
	updateBusy?: boolean;
	dispatch: (command: DesktopAppCommand["command"]) => void;
	showUpdateGuidance: () => void;
	reloadWindow: () => void;
	runtimeFailed?: boolean;
	restartRuntime?: () => void;
	exportDiagnostics?: () => void;
}

/** Native accelerators emit one typed product command; shared UI handlers retain enablement policy. */
export function desktopMenuTemplate(actions: DesktopMenuActions): MenuItemConstructorOptions[] {
	const mac = (actions.platform ?? process.platform) === "darwin";
	const command = (
		id: string,
		label: string,
		value: DesktopAppCommand["command"],
		accelerator?: string,
	): MenuItemConstructorOptions => ({
		id,
		label,
		accelerator,
		enabled: actions.productReady && actions.availableCommands?.includes(value) === true,
		click: () => actions.dispatch(value),
	});
	const template: MenuItemConstructorOptions[] = [
		{
			label: actions.appName,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				command("desktop.settings", "Settings…", "settings", "Cmd+,"),
				{ type: "separator" },
				{
					id: "desktop.updateGuidance",
					label: actions.updateLabel ?? "Update Quarterdeck…",
					enabled: actions.updateGuidanceAvailable && actions.updateBusy !== true,
					click: actions.showUpdateGuidance,
				},
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "File",
			submenu: [
				command("desktop.addProject", "Add Project…", "open-project", "Cmd+O"),
				command("desktop.newTask", "New Task…", "new-task", "Cmd+N"),
				{ type: "separator" },
				{
					id: "desktop.restartRuntime",
					label: "Restart Runtime…",
					enabled: actions.runtimeFailed === true,
					click: () => actions.restartRuntime?.(),
				},
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				command("desktop.home", "Home", "home"),
				command("desktop.files", "Files", "files"),
				command("desktop.git", "Git", "git"),
				command("desktop.terminal", "Task Terminal", "terminal"),
				{ type: "separator" },
				command("desktop.toggleShell", "Toggle Shell", "toggle-shell", "Cmd+J"),
				command("desktop.fileFinder", "Find File…", "file-finder", "Cmd+P"),
				command("desktop.textSearch", "Search Text…", "text-search", "Cmd+Shift+F"),
				{ type: "separator" },
				{
					id: "desktop.reload",
					label: "Reload Window",
					accelerator: "Cmd+R",
					enabled: actions.productReady && actions.runtimeConnected === true,
					click: actions.reloadWindow,
				},
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			role: "windowMenu",
			submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
		},
		{
			role: "help",
			submenu: [
				command("desktop.diagnostics", "Diagnostics…", "diagnostics", "Cmd+Shift+D"),
				{
					id: "desktop.exportDiagnostics",
					label: "Export Diagnostics…",
					enabled: actions.exportDiagnostics !== undefined,
					click: () => actions.exportDiagnostics?.(),
				},
			],
		},
	];
	if (mac) return template;
	// Windows keeps application actions under File and uses Ctrl accelerators.
	const applicationMenu = template.shift();
	const file = template.find((item) => item.label === "File");
	const applicationItems = applicationMenu && Array.isArray(applicationMenu.submenu) ? applicationMenu.submenu : [];
	if (file && Array.isArray(file.submenu)) {
		file.submenu.push(
			{ type: "separator" },
			...applicationItems.filter(
				(item) => item.id === "desktop.settings" || item.id === "desktop.updateGuidance" || item.role === "quit",
			),
		);
	}
	for (const item of template) {
		if (!Array.isArray(item.submenu)) continue;
		item.submenu = item.submenu.filter((entry) => entry.role !== "front" && entry.role !== "zoom");
		for (const entry of item.submenu) {
			if (typeof entry.accelerator === "string") entry.accelerator = entry.accelerator.replace(/^Cmd\+/u, "Ctrl+");
		}
	}
	return template;
}
