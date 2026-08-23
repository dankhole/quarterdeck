import type { BrowserDiagnosticSnapshot } from "@/runtime/types";

export interface BrowserSnapshotContext {
	activeProjectId: string | null;
	activeTaskId: string | null;
	boardRevision: number | null;
	pendingProjectPersistence: boolean;
}

export interface CollectBrowserDiagnosticSnapshotOptions {
	clientId: string;
	connected: boolean;
	context: BrowserSnapshotContext;
	terminalSnapshotProvider: (() => unknown) | null;
}

function collectLayout(): BrowserDiagnosticSnapshot["layout"] {
	const selectors: Record<string, string> = {
		root: "#root",
		topBar: ".kb-top-bar",
		terminalParking: "#quarterdeck-terminal-parking-root",
	};
	const layout: BrowserDiagnosticSnapshot["layout"] = {};
	for (const [name, selector] of Object.entries(selectors)) {
		const element = document.querySelector(selector);
		if (!(element instanceof HTMLElement)) continue;
		const rect = element.getBoundingClientRect();
		layout[name] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
	}
	return layout;
}

export function collectBrowserDiagnosticSnapshot(
	options: CollectBrowserDiagnosticSnapshotOptions,
): BrowserDiagnosticSnapshot {
	const visibility = ["visible", "hidden", "prerender", "unloaded"].includes(document.visibilityState)
		? (document.visibilityState as BrowserDiagnosticSnapshot["visibility"])
		: "unknown";
	return {
		version: 1,
		clientId: options.clientId,
		capturedAt: Date.now(),
		route: window.location.pathname.slice(0, 256),
		visibility,
		viewport: {
			width: Math.max(0, Math.floor(window.innerWidth)),
			height: Math.max(0, Math.floor(window.innerHeight)),
			devicePixelRatio: Math.max(0.1, window.devicePixelRatio || 1),
		},
		activeProjectId: options.context.activeProjectId,
		activeTaskId: options.context.activeTaskId,
		boardRevision: options.context.boardRevision,
		runtimeStream: { connected: options.connected },
		pendingProjectPersistence: options.context.pendingProjectPersistence,
		terminal: options.terminalSnapshotProvider?.() ?? null,
		layout: collectLayout(),
	};
}
