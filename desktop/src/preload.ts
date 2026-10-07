import { contextBridge, ipcRenderer } from "electron";
import { type DesktopBootstrap, QUARTERDECK_DESKTOP_BRIDGE_VERSION } from "../../src/shared/desktop-bridge-contract.js";
import { DESKTOP_BOOTSTRAP_CHANNEL } from "./desktop-ipc-channels.js";
import { createDesktopBridge } from "./preload-bridge.js";

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
		contextBridge.exposeInMainWorld(
			"quarterdeckDesktop",
			createDesktopBridge(envelope.bootstrap as DesktopBootstrap, ipcRenderer, envelope.documentId),
		);
	}
}
