import { EventEmitter } from "node:events";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCompareWindowPath, type CompareWindowTarget } from "../../src/shared/compare-window-contract.js";
import { DesktopCompareWindows } from "../src/compare-windows.js";
import { DESKTOP_COMPARE_OPEN_CHANNEL } from "../src/desktop-ipc-channels.js";
import type { ApprovedRenderer } from "../src/renderer-admission.js";
import { DesktopRendererRegistry } from "../src/renderer-registry.js";
import { RuntimeSelection } from "../src/runtime-selection.js";

const native = vi.hoisted(() => ({
	windows: [] as FakeWindow[],
	options: [] as Record<string, unknown>[],
	failLoad: false,
}));
let nextId = 0;
class FakeWindow extends EventEmitter {
	destroyed = false;
	show = vi.fn();
	hide = vi.fn();
	webContents = Object.assign(new EventEmitter(), {
		id: ++nextId,
		mainFrame: { url: "" },
		isDestroyed: () => this.destroyed,
		getURL: () => this.webContents.mainFrame.url,
		setWindowOpenHandler: vi.fn(),
		loadURL: vi.fn(async (url: string) => {
			this.webContents.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
			this.webContents.mainFrame.url = url;
			if (native.failLoad) throw new Error("Synthetic load failure");
		}),
	});
	constructor(options: Record<string, unknown>) {
		super();
		native.windows.push(this);
		native.options.push(options);
	}
	static fromWebContents(contents: WebContents): FakeWindow | null {
		return native.windows.find((window) => window.webContents.id === contents.id) ?? null;
	}
	isDestroyed(): boolean {
		return this.destroyed;
	}
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit("closed");
	}
}
vi.mock("electron", () => ({
	BrowserWindow: Object.assign(
		vi.fn(function createWindow(options: Record<string, unknown>) {
			return new FakeWindow(options);
		}),
		{
			fromWebContents: (contents: WebContents) => FakeWindow.fromWebContents(contents),
		},
	),
	shell: { openExternal: vi.fn() },
}));

const target: CompareWindowTarget = {
	projectId: "project-1",
	taskId: "task-1",
	taskCreatedAt: 42,
	sourceRef: "feature/a",
	targetRef: "main",
	includeUncommitted: true,
	threeDotDiff: true,
};

function fixture() {
	const selection = new RuntimeSelection();
	selection.select({ generation: "generation-1", origin: "http://127.0.0.1:12345", clientToken: "a".repeat(43) });
	const mainWindow = new FakeWindow({});
	mainWindow.webContents.mainFrame.url = "app://quarterdeck/project-1";
	const main: ApprovedRenderer = {
		contents: mainWindow.webContents as unknown as WebContents,
		generation: "generation-1",
		documentId: "main-document",
	};
	const registry = new DesktopRendererRegistry(() => main);
	let handler: Parameters<IpcMain["handle"]>[1] | undefined;
	const ipc = {
		handle: vi.fn((channel: string, callback: Parameters<IpcMain["handle"]>[1]) => {
			expect(channel).toBe(DESKTOP_COMPARE_OPEN_CHANNEL);
			handler = callback;
		}),
		removeHandler: vi.fn(),
	};
	const canOpen = vi.fn(() => true);
	const owner = new DesktopCompareWindows({
		ipc,
		registry,
		selection,
		getMainRenderer: () => main,
		canOpen,
		partition: "persist:synthetic",
		preloadPath: "/synthetic/preload.cjs",
		isSynthetic: true,
		showWindow: true,
	});
	const payload = { runtimeGeneration: "generation-1", documentId: "main-document", target };
	const event = { sender: main.contents, senderFrame: main.contents.mainFrame } as IpcMainInvokeEvent;
	const invoke = async (input: unknown = payload, sender = event): Promise<unknown> => {
		if (!handler) throw new Error("Handler not installed");
		return await handler(sender, input);
	};
	return { main, mainWindow, registry, owner, selection, payload, event, invoke, ipc, canOpen };
}

beforeEach(() => {
	native.windows.length = 0;
	native.options.length = 0;
	native.failLoad = false;
});

describe("desktop Compare window ownership", () => {
	it("opens a sandboxed independent viewer and destroys only that viewer on close", async () => {
		const f = fixture();
		expect(await f.invoke()).toEqual({ kind: "opened" });
		const viewer = native.windows[1];
		const renderer = f.registry.get(viewer.webContents.id);
		expect(renderer?.role).toBe("compare");
		expect(renderer?.documentUrl).toBe(`app://quarterdeck${buildCompareWindowPath(target)}`);
		expect(renderer?.documentId).toBeTruthy();
		expect(native.options[1]).toMatchObject({
			webPreferences: {
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				partition: "persist:synthetic",
			},
		});
		expect(viewer.show).toHaveBeenCalledOnce();
		const close = { preventDefault: vi.fn() };
		viewer.emit("close", close);
		expect(close.preventDefault).not.toHaveBeenCalled();
		viewer.destroy();
		expect(f.registry.get(viewer.webContents.id)).toBeNull();
		expect(f.mainWindow.destroyed).toBe(false);
		expect(f.mainWindow.hide).not.toHaveBeenCalled();
		f.owner.dispose();
	});

	it("rejects wrong documents, generations, frames, Compare senders and renderer-provided destinations", async () => {
		const f = fixture();
		for (const payload of [
			{ ...f.payload, url: "https://evil.test" },
			{ ...f.payload, documentId: "retired" },
			{ ...f.payload, runtimeGeneration: "retired" },
			{ ...f.payload, target: { ...target, path: "/tmp/repository" } },
		])
			expect(await f.invoke(payload)).toEqual({ kind: "unavailable" });
		expect(await f.invoke(f.payload, { ...f.event, senderFrame: null })).toEqual({ kind: "unavailable" });
		expect(native.windows).toHaveLength(1);
		expect(await f.invoke()).toEqual({ kind: "opened" });
		const viewer = native.windows[1];
		expect(
			await f.invoke(f.payload, {
				sender: viewer.webContents,
				senderFrame: viewer.webContents.mainFrame,
			} as unknown as IpcMainInvokeEvent),
		).toEqual({ kind: "unavailable" });
		f.canOpen.mockReturnValue(false);
		expect(await f.invoke()).toEqual({ kind: "unavailable" });
		f.owner.dispose();
	});

	it("revokes all viewer identities on runtime replacement, including reuse of the generation label", async () => {
		const f = fixture();
		await f.invoke();
		const viewer = native.windows[1];
		const renderer = f.registry.get(viewer.webContents.id);
		f.selection.select({ generation: "generation-1", origin: "http://127.0.0.1:12346", clientToken: "b".repeat(43) });
		expect(viewer.destroyed).toBe(true);
		expect(renderer?.generation).toBeNull();
		expect(renderer?.documentId).toBeNull();
		expect(f.registry.get(viewer.webContents.id)).toBeNull();
		expect(f.mainWindow.destroyed).toBe(false);
		f.owner.dispose();
	});

	it("isolates renderer crashes and refuses navigation away from the fixed viewer document", async () => {
		const f = fixture();
		await f.invoke();
		native.windows[1].webContents.emit("render-process-gone", {}, { reason: "crashed" });
		expect(native.windows[1].destroyed).toBe(true);
		expect(f.mainWindow.destroyed).toBe(false);
		await f.invoke();
		const viewer = native.windows[2];
		viewer.webContents.emit("did-start-navigation", {
			isMainFrame: true,
			isSameDocument: false,
			url: "app://quarterdeck/other",
		});
		expect(viewer.destroyed).toBe(true);
		f.owner.dispose();
	});

	it("cleans up failed loads and application shutdown without changing main-window state", async () => {
		const f = fixture();
		native.failLoad = true;
		expect(await f.invoke()).toEqual({ kind: "failed" });
		expect(native.windows[1].destroyed).toBe(true);
		native.failLoad = false;
		await f.invoke();
		f.owner.dispose();
		expect(native.windows[2].destroyed).toBe(true);
		expect(f.ipc.removeHandler).toHaveBeenCalledWith(DESKTOP_COMPARE_OPEN_CHANNEL);
		expect(await f.invoke()).toEqual({ kind: "unavailable" });
		expect(f.mainWindow.destroyed).toBe(false);
	});
});
