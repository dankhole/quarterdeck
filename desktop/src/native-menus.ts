import type { MenuItemConstructorOptions } from "electron";
import type { DesktopAppCommand } from "../../src/shared/desktop-bridge-contract.js";

export interface DesktopMenuActions {
	appName: string;
	productReady: boolean;
	availableCommands?: readonly DesktopAppCommand["command"][];
	runtimeConnected?: boolean;
	updatesAvailable: boolean;
	updatePending: boolean;
	dispatch: (command: DesktopAppCommand["command"]) => void;
	openInBrowser: () => void;
	checkForUpdates: () => void;
	restartToUpdate: () => void;
	reloadWindow: () => void;
	runtimeFailed?: boolean;
	restartRuntime?: () => void;
	environmentSetup?: () => void;
	exportDiagnostics?: () => void;
}

/** Native accelerators emit one typed product command; shared UI handlers retain enablement policy. */
export function desktopMenuTemplate(actions: DesktopMenuActions): MenuItemConstructorOptions[] {
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
	return [
		{
			label: actions.appName,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				command("desktop.settings", "Settings…", "settings", "Cmd+,"),
				{
					id: "desktop.environment",
					label: "Runtime Environment…",
					enabled: actions.environmentSetup !== undefined,
					click: () => actions.environmentSetup?.(),
				},
				{ type: "separator" },
				{
					id: "desktop.checkUpdates",
					label: "Check for Updates…",
					enabled: actions.updatesAvailable,
					click: actions.checkForUpdates,
				},
				{
					id: "desktop.restartUpdate",
					label: "Restart to Update…",
					visible: actions.updatePending,
					enabled: actions.updatePending,
					click: actions.restartToUpdate,
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
					id: "desktop.openInBrowser",
					label: "Open in Browser",
					enabled: actions.productReady && actions.runtimeConnected === true,
					click: actions.openInBrowser,
				},
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
}
