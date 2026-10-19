import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { DesktopUpdateSnapshot } from "../../src/shared/desktop-update-contract.js";
import {
	DESKTOP_UPDATE_INTENT_CHANNEL,
	DESKTOP_UPDATE_SNAPSHOT_CHANNEL,
	DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL,
} from "../src/desktop-ipc-channels.js";
import { installDesktopUpdateIpc } from "../src/update-ipc.js";

const snapshot: DesktopUpdateSnapshot = {
	phase: "available",
	installedVersion: "0.12.8",
	availableVersion: "0.12.9",
	channel: "latest",
};

function fixture() {
	const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>();
	const listeners = new Map<string, (event: IpcMainEvent, payload: unknown) => void>();
	const ipc = {
		handle: vi.fn((channel, handler) => {
			handlers.set(channel, handler);
		}),
		removeHandler: vi.fn((channel) => {
			handlers.delete(channel);
		}),
		on: vi.fn((channel, listener): IpcMain => {
			listeners.set(channel, listener);
			return ipc as unknown as IpcMain;
		}),
		removeListener: vi.fn((channel): IpcMain => {
			listeners.delete(channel);
			return ipc as unknown as IpcMain;
		}),
	} satisfies Parameters<typeof installDesktopUpdateIpc>[0]["ipc"];
	const send = vi.fn();
	const contents = {
		mainFrame: { url: "app://quarterdeck/" } as WebFrameMain,
		isDestroyed: () => false,
		send,
	} as unknown as WebContents;
	const renderer = { contents, generation: "generation", documentId: "document" };
	const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent;
	const identity = { runtimeGeneration: "generation", documentId: "document" };
	let publish: (value: DesktopUpdateSnapshot) => void = () => {};
	const unsubscribe = vi.fn();
	const request = vi.fn(async () => {});
	const dispose = installDesktopUpdateIpc({
		ipc,
		getRenderer: () => renderer,
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			publish = listener;
			return unsubscribe;
		},
		request,
	});
	const invoke = (channel: string, payload: unknown, sender = event) => handlers.get(channel)?.(sender, payload);
	const subscribe = (payload: unknown, sender = event): void => {
		listeners.get(DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL)?.(sender as unknown as IpcMainEvent, payload);
	};
	return { ipc, renderer, event, identity, send, request, dispose, unsubscribe, invoke, subscribe, publish };
}

describe("desktop update IPC admission", () => {
	it("returns sanitized snapshots and admits only fixed update intents", async () => {
		const { invoke, identity, request } = fixture();
		expect(invoke(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, identity)).toEqual({ ...identity, revision: 0, snapshot });
		for (const intent of ["check", "details"]) {
			expect(await invoke(DESKTOP_UPDATE_INTENT_CHANNEL, { ...identity, intent })).toBe(true);
		}
		expect(request.mock.calls).toEqual([["check"], ["details"]]);
	});

	it("rejects unknown payload keys, arbitrary targets, stale documents/generations and unapproved frames", async () => {
		const { invoke, identity, event, request, subscribe, publish, send } = fixture();
		for (const payload of [
			null,
			[],
			{ ...identity, documentId: "stale" },
			{ ...identity, runtimeGeneration: "stale" },
			{ ...identity, version: "9.9.9" },
			{ ...identity, command: "npm install" },
		]) {
			expect(invoke(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, payload)).toBeNull();
			expect(await invoke(DESKTOP_UPDATE_INTENT_CHANNEL, { ...(payload as object), intent: "details" })).toBe(false);
			subscribe({ ...(payload as object), subscribed: true });
		}
		for (const sender of [
			{ ...event, senderFrame: null },
			{ ...event, sender: {} as WebContents },
			{ ...event, senderFrame: { url: "app://quarterdeck/" } as WebFrameMain },
		]) {
			expect(invoke(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, identity, sender)).toBeNull();
			expect(await invoke(DESKTOP_UPDATE_INTENT_CHANNEL, { ...identity, intent: "details" }, sender)).toBe(false);
			subscribe({ ...identity, subscribed: true }, sender);
		}
		for (const intent of ["execute", { command: "npm install" }, { intent: "details", version: "9.9.9" }])
			expect(await invoke(DESKTOP_UPDATE_INTENT_CHANNEL, { ...identity, intent })).toBe(false);
		publish(snapshot);
		expect(request).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("binds publication to the admitted document and cleans explicit subscriptions", () => {
		const { identity, subscribe, publish, send, renderer } = fixture();
		subscribe({ ...identity, subscribed: true });
		publish(snapshot);
		expect(send).toHaveBeenLastCalledWith(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, { ...identity, revision: 1, snapshot });
		subscribe({ ...identity, documentId: "stale", subscribed: false });
		publish(snapshot);
		expect(send).toHaveBeenCalledTimes(2);
		subscribe({ ...identity, subscribed: false });
		publish(snapshot);
		expect(send).toHaveBeenCalledTimes(2);
		subscribe({ ...identity, subscribed: true });
		renderer.documentId = "replacement";
		publish(snapshot);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("rejects navigated, destroyed and generation-replaced subscriptions on delivery", () => {
		for (const invalidate of [
			(renderer: ReturnType<typeof fixture>["renderer"]) => {
				renderer.generation = "replacement";
			},
			(renderer: ReturnType<typeof fixture>["renderer"]) => {
				Object.defineProperty(renderer.contents.mainFrame, "url", { value: "https://unapproved.test/" });
			},
			(renderer: ReturnType<typeof fixture>["renderer"]) => {
				renderer.contents.isDestroyed = () => true;
			},
		]) {
			const { subscribe, publish, identity, renderer, send } = fixture();
			subscribe({ ...identity, subscribed: true });
			invalidate(renderer);
			publish(snapshot);
			expect(send).not.toHaveBeenCalled();
		}
	});

	it("disposes handlers and controller subscription once and ignores late callbacks", async () => {
		const { subscribe, publish, identity, send, dispose, unsubscribe, ipc, invoke, request } = fixture();
		subscribe({ ...identity, subscribed: true });
		dispose();
		dispose();
		publish(snapshot);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(ipc.removeHandler.mock.calls).toEqual([
			[DESKTOP_UPDATE_SNAPSHOT_CHANNEL],
			[DESKTOP_UPDATE_INTENT_CHANNEL],
		]);
		expect(ipc.removeListener).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
		expect(await invoke(DESKTOP_UPDATE_INTENT_CHANNEL, { ...identity, intent: "details" })).toBeUndefined();
		expect(request).not.toHaveBeenCalled();
	});

	it("normalizes native request failures without returning exception details", async () => {
		const { invoke, identity, request } = fixture();
		request.mockRejectedValueOnce(new Error("private path /synthetic/owner"));
		expect(await invoke(DESKTOP_UPDATE_INTENT_CHANNEL, { ...identity, intent: "details" })).toBe(false);
	});
});
