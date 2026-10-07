import { BrowserWindow, shell } from "electron";
import type { ApprovedRenderer } from "./renderer-admission.js";
import { desktopUrl, externalWebUrl } from "./security-policy.js";

export interface DesktopWindowOptions {
	partition: string;
	preloadPath: string;
	isQuitting: () => boolean;
	isSynthetic: boolean;
	showWindow: boolean;
	onSurfaceAction: (action: "retry" | "reload") => void;
	onRendererFailed: () => void;
	onDocumentNavigation?: () => void;
}

export function createDesktopWindow(options: DesktopWindowOptions): ApprovedRenderer {
	const window = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 760,
		minHeight: 540,
		show: options.showWindow,
		backgroundColor: "#24292e",
		title: "Quarterdeck",
		webPreferences: {
			preload: options.preloadPath,
			partition: options.partition,
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			allowRunningInsecureContent: false,
			webviewTag: false,
			spellcheck: false,
		},
	});
	const renderer: ApprovedRenderer = { contents: window.webContents, generation: null };
	window.on("close", (event) => {
		if (!options.isQuitting()) {
			event.preventDefault();
			window.hide();
		}
	});
	const openExternal = (value: string): void => {
		const safe = externalWebUrl(value);
		if (safe && !options.isSynthetic) void shell.openExternal(safe).catch(() => undefined);
	};
	window.webContents.setWindowOpenHandler(({ url }) => {
		openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-frame-navigate", (event) => {
		const url = desktopUrl(event.url);
		if (!event.isMainFrame) {
			event.preventDefault();
			return;
		}
		if (url?.pathname === "/__desktop/retry" || url?.pathname === "/__desktop/reload") {
			event.preventDefault();
			options.onSurfaceAction(url.pathname.endsWith("reload") ? "reload" : "retry");
			return;
		}
		if (!url) {
			event.preventDefault();
			openExternal(event.url);
		} else {
			// Full-document product navigation shares the native reload draft gate. SPA history does not fire this event.
			event.preventDefault();
			options.onDocumentNavigation?.();
		}
	});
	window.webContents.on("will-redirect", (event) => event.preventDefault());
	window.webContents.on("will-attach-webview", (event) => event.preventDefault());
	window.webContents.on("render-process-gone", (_event, details) => {
		if (!options.isQuitting() && details.reason !== "clean-exit") options.onRendererFailed();
	});
	return renderer;
}

export function restoreDesktopWindow(renderer: ApprovedRenderer | null): void {
	if (!renderer || renderer.contents.isDestroyed()) return;
	const window = BrowserWindow.fromWebContents(renderer.contents);
	if (!window) return;
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}
