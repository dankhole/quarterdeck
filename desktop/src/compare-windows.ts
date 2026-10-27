import { randomUUID } from "node:crypto";
import { BrowserWindow, type IpcMain } from "electron";
import { z } from "zod";
import {
	buildCompareWindowPath,
	type CompareWindowOpenResponse,
	compareWindowTargetSchema,
} from "../../src/shared/compare-window-contract.js";
import { DESKTOP_COMPARE_OPEN_CHANNEL } from "./desktop-ipc-channels.js";
import { createDesktopWindow } from "./desktop-window.js";
import { type ApprovedRenderer, isApprovedDocumentSender } from "./renderer-admission.js";
import type { DesktopRendererRegistry } from "./renderer-registry.js";
import type { RuntimeSelection } from "./runtime-selection.js";
import { DESKTOP_ORIGIN } from "./security-policy.js";

const requestSchema = z.strictObject({
	documentId: z.string().min(1).max(128),
	runtimeGeneration: z.string().min(1).max(128),
	target: compareWindowTargetSchema,
});

interface CompareWindowsOptions {
	ipc: Pick<IpcMain, "handle" | "removeHandler">;
	registry: DesktopRendererRegistry;
	selection: RuntimeSelection;
	getMainRenderer: () => ApprovedRenderer | null;
	canOpen: () => boolean;
	partition: string;
	preloadPath: string;
	isSynthetic: boolean;
	showWindow: boolean;
}

/** Owns transport-only viewers. Their lifetime never owns runtime, agents, drafts or the main window. */
export class DesktopCompareWindows {
	private readonly windows = new Set<BrowserWindow>();
	private disposed = false;

	constructor(private readonly options: CompareWindowsOptions) {
		options.ipc.handle(
			DESKTOP_COMPARE_OPEN_CHANNEL,
			async (event, payload: unknown): Promise<CompareWindowOpenResponse> => {
				const request = requestSchema.safeParse(payload);
				const main = options.getMainRenderer();
				const runtime = options.selection.get();
				if (
					this.disposed ||
					!request.success ||
					!main ||
					!runtime ||
					!options.canOpen() ||
					!isApprovedDocumentSender(event, main, runtime.generation) ||
					request.data.documentId !== main.documentId ||
					request.data.runtimeGeneration !== runtime.generation
				) {
					return { kind: "unavailable" };
				}
				// Bound native resources without replacing another viewer's window-local navigation.
				if (this.windows.size >= 8) return { kind: "unavailable" };
				let window: BrowserWindow | null = null;
				try {
					const renderer = createDesktopWindow({
						partition: options.partition,
						preloadPath: options.preloadPath,
						isSynthetic: options.isSynthetic,
						showWindow: false,
						// Closing a read-only viewer destroys it; only the main app window hides.
						isQuitting: () => this.disposed,
						closeBehavior: "destroy",
						title: "Compare — Quarterdeck",
						onSurfaceAction: () => undefined,
						onRendererFailed: () => window?.destroy(),
					});
					window = BrowserWindow.fromWebContents(renderer.contents);
					if (!window) return { kind: "failed" };
					const viewer = window;
					const url = `${DESKTOP_ORIGIN}${buildCompareWindowPath(request.data.target)}`;
					renderer.role = "compare";
					renderer.documentUrl = url;
					renderer.generation = runtime.generation;
					renderer.documentId = randomUUID();
					const unregister = options.registry.addCompare(renderer);
					this.windows.add(viewer);
					const revoke = (): void => {
						renderer.generation = null;
						renderer.documentId = null;
						unregister();
						if (!viewer.isDestroyed()) viewer.destroy();
					};
					runtime.signal.addEventListener("abort", revoke, { once: true });
					viewer.once("closed", () => {
						renderer.generation = null;
						renderer.documentId = null;
						unregister();
						runtime.signal.removeEventListener("abort", revoke);
						this.windows.delete(viewer);
					});
					renderer.contents.on("did-start-navigation", (navigation) => {
						if (!navigation.isMainFrame || navigation.isSameDocument) return;
						if (navigation.url !== url || options.selection.get() !== runtime || runtime.signal.aborted) revoke();
						else renderer.documentId = randomUUID();
					});
					await renderer.contents.loadURL(url);
					if (
						viewer.isDestroyed() ||
						this.disposed ||
						options.selection.get() !== runtime ||
						runtime.signal.aborted
					) {
						revoke();
						return { kind: "unavailable" };
					}
					if (options.showWindow) viewer.show();
					return { kind: "opened" };
				} catch {
					if (window && !window.isDestroyed()) window.destroy();
					return { kind: "failed" };
				}
			},
		);
	}

	closeAll(): void {
		for (const window of this.windows) if (!window.isDestroyed()) window.destroy();
	}

	dispose(): void {
		this.disposed = true;
		this.options.ipc.removeHandler(DESKTOP_COMPARE_OPEN_CHANNEL);
		this.closeAll();
	}
}
