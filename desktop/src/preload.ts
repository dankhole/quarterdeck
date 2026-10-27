import { contextBridge, ipcRenderer } from "electron";
import { type DesktopBootstrap, QUARTERDECK_DESKTOP_BRIDGE_VERSION } from "../../src/shared/desktop-bridge-contract.js";
import { DESKTOP_BOOTSTRAP_CHANNEL } from "./desktop-ipc-channels.js";
import { createCompareDesktopBridge, createDesktopBridge, createDesktopCompareBridge } from "./preload-bridge.js";
import { createDesktopEnvironmentBridge } from "./preload-environment-bridge.js";
import { createDesktopUpdateBridge } from "./preload-update-bridge.js";

// Startup/error pages deliberately receive no bridge.
if (
	window.location.protocol === "app:" &&
	window.location.host === "quarterdeck" &&
	!window.location.pathname.startsWith("/__desktop/")
) {
	const envelope: unknown = ipcRenderer.sendSync(DESKTOP_BOOTSTRAP_CHANNEL, {
		version: QUARTERDECK_DESKTOP_BRIDGE_VERSION,
	});
	if (
		envelope &&
		typeof envelope === "object" &&
		"bootstrap" in envelope &&
		"documentId" in envelope &&
		typeof envelope.documentId === "string"
	) {
		const compare = "role" in envelope && envelope.role === "compare";
		contextBridge.exposeInMainWorld(
			"quarterdeckDesktop",
			compare
				? createCompareDesktopBridge(envelope.bootstrap as DesktopBootstrap)
				: createDesktopBridge(envelope.bootstrap as DesktopBootstrap, ipcRenderer, envelope.documentId),
		);
		if (!compare) {
			contextBridge.exposeInMainWorld(
				"quarterdeckDesktopCompare",
				createDesktopCompareBridge(envelope.bootstrap as DesktopBootstrap, ipcRenderer, envelope.documentId),
			);
			contextBridge.exposeInMainWorld(
				"quarterdeckDesktopEnvironment",
				createDesktopEnvironmentBridge(envelope.bootstrap as DesktopBootstrap, ipcRenderer, envelope.documentId),
			);
			contextBridge.exposeInMainWorld(
				"quarterdeckDesktopUpdates",
				createDesktopUpdateBridge(envelope.bootstrap as DesktopBootstrap, ipcRenderer, envelope.documentId),
			);
		}
	}
}
