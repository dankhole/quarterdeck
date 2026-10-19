import { describe, expect, it, vi } from "vitest";
import type { DesktopUpdateIntent, DesktopUpdateSnapshot } from "../../src/shared/desktop-update-contract.js";
import {
	DESKTOP_UPDATE_INTENT_CHANNEL,
	DESKTOP_UPDATE_SNAPSHOT_CHANNEL,
	DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL,
} from "../src/desktop-ipc-channels.js";
import { createDesktopUpdateBridge } from "../src/preload-update-bridge.js";

const generation = "generation-current";
const documentId = "document-current";
type Ipc = Parameters<typeof createDesktopUpdateBridge>[1];
function fixture() {
	const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
	const invoke = vi.fn<Ipc["invoke"]>().mockResolvedValue(null);
	const ipc: Ipc = {
		on: (channel, listener) => {
			const callbacks = listeners.get(channel) ?? new Set();
			callbacks.add(listener);
			listeners.set(channel, callbacks);
		},
		removeListener: vi.fn((channel, listener) => {
			listeners.get(channel)?.delete(listener);
		}),
		send: vi.fn<Ipc["send"]>(),
		invoke,
	};
	const bridge = createDesktopUpdateBridge(
		{
			runtimeOrigin: "http://127.0.0.1:12345",
			runtimeGeneration: generation,
			capabilities: { desktop: true, nativeDialogs: true, nativeNotifications: false },
		},
		ipc,
		documentId,
	);
	const emit = (channel: string, payload: unknown): void => {
		for (const listener of listeners.get(channel) ?? []) listener({ nativeEvent: true }, payload);
	};
	return { bridge, invoke, ipc, emit };
}

describe("optional desktop update preload namespace", () => {
	it("freezes a separately versioned narrow API without private identity", () => {
		const { bridge } = fixture();
		expect(Object.isFrozen(bridge)).toBe(true);
		expect(bridge.version).toBe(1);
		expect(Object.keys(bridge).sort()).toEqual(["getSnapshot", "onSnapshot", "request", "version"]);
	});

	it("admits only fixed update intents and does not expose invoke failures", async () => {
		const { bridge, invoke } = fixture();
		const request = bridge.request;
		await request({ intent: "details", version: "99.0.0" } as unknown as DesktopUpdateIntent);
		await request("execute" as DesktopUpdateIntent);
		expect(invoke).not.toHaveBeenCalled();
		invoke.mockRejectedValueOnce(new Error("private native error"));
		await expect(request("details")).resolves.toBeUndefined();
		expect(invoke).toHaveBeenCalledExactlyOnceWith(DESKTOP_UPDATE_INTENT_CHANNEL, {
			documentId,
			runtimeGeneration: generation,
			intent: "details",
		});
	});

	it("keeps the newest publication when a stale initial snapshot resolves later", async () => {
		const { bridge, invoke, emit } = fixture();
		const available: DesktopUpdateSnapshot = {
			phase: "available",
			installedVersion: "0.12.8",
			availableVersion: "0.12.9",
			channel: "latest",
		};
		const envelope = { documentId, runtimeGeneration: generation, revision: 2, snapshot: available };
		let resolve: (value: unknown) => void = () => {};
		invoke.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const listener = vi.fn();
		bridge.onSnapshot(listener);
		const pending = bridge.getSnapshot();
		emit(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, envelope);
		resolve({ ...envelope, revision: 1, snapshot: { ...available, phase: "checking", availableVersion: null } });
		expect(await pending).toEqual(available);
		expect(listener).toHaveBeenCalledExactlyOnceWith(available);
	});

	it("shares one admitted update subscription and removes it after the last listener", async () => {
		const { bridge, ipc, invoke, emit } = fixture();
		const snapshot: DesktopUpdateSnapshot = {
			phase: "current",
			installedVersion: "0.12.8",
			availableVersion: null,
			channel: "latest",
		};
		const envelope = { documentId, runtimeGeneration: generation, revision: 1, snapshot };
		const first = vi.fn();
		const second = vi.fn();
		const offFirst = bridge.onSnapshot(first);
		const offSecond = bridge.onSnapshot(second);
		expect(ipc.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL, {
			documentId,
			runtimeGeneration: generation,
			subscribed: true,
		});
		for (const invalid of [
			{ ...envelope, documentId: "stale" },
			{ ...envelope, runtimeGeneration: "stale" },
			{ ...envelope, revision: -1 },
			{ ...envelope, snapshot: { ...snapshot, ownerPath: "/private/path" } },
			{ ...envelope, secret: "forbidden" },
		])
			emit(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, invalid);
		expect(first).not.toHaveBeenCalled();
		invoke.mockResolvedValueOnce(envelope);
		expect(await bridge.getSnapshot()).toEqual(snapshot);
		// Reads also publish accepted revisions so another mounted listener cannot miss a live update.
		expect(first).toHaveBeenCalledExactlyOnceWith(snapshot);
		expect(second).toHaveBeenCalledExactlyOnceWith(snapshot);
		emit(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, envelope);
		expect(first).toHaveBeenCalledTimes(1);
		offFirst();
		offFirst();
		expect(ipc.removeListener).not.toHaveBeenCalled();
		emit(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, { ...envelope, revision: 2 });
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(2);
		offSecond();
		expect(ipc.removeListener).toHaveBeenCalledTimes(1);
		expect(ipc.send).toHaveBeenLastCalledWith(DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL, {
			documentId,
			runtimeGeneration: generation,
			subscribed: false,
		});
		emit(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, { ...envelope, revision: 3 });
		expect(second).toHaveBeenCalledTimes(2);
	});

	it("returns null for invalid update snapshots and failed native reads", async () => {
		const { bridge, invoke } = fixture();
		for (const value of [null, { snapshot: {} }, { phase: "available" }]) {
			invoke.mockResolvedValueOnce(value);
			expect(await bridge.getSnapshot()).toBeNull();
		}
		invoke.mockRejectedValueOnce(new Error("private native error"));
		expect(await bridge.getSnapshot()).toBeNull();
	});
});
