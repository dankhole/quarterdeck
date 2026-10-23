import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { DesktopEnvironmentSnapshot } from "../../src/shared/desktop-environment-contract.js";
import {
	DESKTOP_ENVIRONMENT_INTENT_CHANNEL,
	DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL,
} from "../src/desktop-ipc-channels.js";
import { installDesktopEnvironmentIpc } from "../src/environment-ipc.js";

const snapshot: DesktopEnvironmentSnapshot = {
	ownership: "owned",
	source: "login-shell",
	failureReason: null,
	appliedDirectories: [],
	appliedImportLoginShellEnvironment: true,
	preferences: { importLoginShellEnvironment: true, extraExecutableDirectories: [] },
};
function fixture() {
	const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>();
	const ipc = {
		handle: vi.fn((channel, handler) => {
			handlers.set(channel, handler);
		}),
		removeHandler: vi.fn((channel) => {
			handlers.delete(channel);
		}),
	} satisfies Parameters<typeof installDesktopEnvironmentIpc>[0]["ipc"];
	const contents = {
		mainFrame: { url: "app://quarterdeck/" } as WebFrameMain,
		isDestroyed: () => false,
	} as unknown as WebContents;
	const renderer = { contents, generation: "generation", documentId: "document" };
	const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent;
	const identity = { runtimeGeneration: "generation", documentId: "document" };
	const controller = {
		getSnapshot: vi.fn(async () => snapshot),
		request: vi
			.fn<Parameters<typeof installDesktopEnvironmentIpc>[0]["controller"]["request"]>()
			.mockResolvedValue({ outcome: "saved", snapshot }),
	};
	const dispose = installDesktopEnvironmentIpc({ ipc, getRenderer: () => renderer, controller });
	const invoke = (channel: string, payload: unknown, sender = event) => handlers.get(channel)?.(sender, payload);
	return { invoke, identity, event, renderer, controller, dispose, ipc };
}

describe("desktop environment IPC admission", () => {
	it("returns only validated metadata and fixed intent responses", async () => {
		const { invoke, identity, controller } = fixture();
		expect(await invoke(DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL, identity)).toEqual({ ...identity, snapshot });
		const intent = { kind: "set-login-shell-import", enabled: false };
		expect(await invoke(DESKTOP_ENVIRONMENT_INTENT_CHANNEL, { ...identity, intent })).toEqual({
			...identity,
			response: { outcome: "saved", snapshot },
		});
		expect(controller.request).toHaveBeenCalledWith(intent, expect.any(Function));
	});

	it("rejects stale identities, unapproved frames, arbitrary paths and payload keys", async () => {
		const { invoke, identity, event, controller } = fixture();
		for (const payload of [
			null,
			[],
			{ ...identity, documentId: "stale" },
			{ ...identity, runtimeGeneration: "stale" },
			{ ...identity, command: "env" },
		]) {
			expect(await invoke(DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL, payload)).toBeNull();
			expect(
				await invoke(DESKTOP_ENVIRONMENT_INTENT_CHANNEL, { ...(payload as object), intent: { kind: "refresh" } }),
			).toBeNull();
		}
		for (const sender of [
			{ ...event, senderFrame: null },
			{ ...event, sender: {} as WebContents },
			{ ...event, senderFrame: { url: "app://quarterdeck/" } as WebFrameMain },
		]) {
			expect(await invoke(DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL, identity, sender)).toBeNull();
			expect(
				await invoke(DESKTOP_ENVIRONMENT_INTENT_CHANNEL, { ...identity, intent: { kind: "refresh" } }, sender),
			).toBeNull();
		}
		for (const intent of [
			{ kind: "add-folders", paths: ["/private"] },
			{ kind: "set-login-shell-import", enabled: "yes" },
			{ kind: "exec", command: "env" },
		]) {
			expect(await invoke(DESKTOP_ENVIRONMENT_INTENT_CHANNEL, { ...identity, intent })).toBeNull();
		}
		expect(controller.getSnapshot).not.toHaveBeenCalled();
		expect(controller.request).not.toHaveBeenCalled();
	});

	it("rechecks admission after async reads and exposes a live admission check to picker actions", async () => {
		const { invoke, identity, renderer, controller } = fixture();
		controller.getSnapshot.mockImplementationOnce(async () => {
			renderer.documentId = "replaced";
			return snapshot;
		});
		expect(await invoke(DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL, identity)).toBeNull();
		renderer.documentId = identity.documentId;
		controller.request.mockImplementationOnce(async (_intent, admitted) => {
			expect(admitted?.()).toBe(true);
			renderer.generation = "replaced";
			expect(admitted?.()).toBe(false);
			return { outcome: "unavailable", snapshot: null };
		});
		expect(
			await invoke(DESKTOP_ENVIRONMENT_INTENT_CHANNEL, { ...identity, intent: { kind: "add-folders" } }),
		).toBeNull();
	});

	it("rejects malformed native replies and hides native exceptions", async () => {
		const { invoke, identity, controller } = fixture();
		controller.getSnapshot.mockResolvedValueOnce({
			...snapshot,
			environment: { SECRET: "private" },
		} as DesktopEnvironmentSnapshot);
		expect(await invoke(DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL, identity)).toBeNull();
		controller.request.mockRejectedValueOnce(new Error("private error"));
		expect(await invoke(DESKTOP_ENVIRONMENT_INTENT_CHANNEL, { ...identity, intent: { kind: "refresh" } })).toBeNull();
	});

	it("disposes handlers once and revokes pending admission", async () => {
		const { invoke, identity, controller, dispose, ipc } = fixture();
		controller.request.mockImplementationOnce(async (_intent, admitted) => {
			dispose();
			dispose();
			expect(admitted?.()).toBe(false);
			return { outcome: "unavailable", snapshot: null };
		});
		expect(await invoke(DESKTOP_ENVIRONMENT_INTENT_CHANNEL, { ...identity, intent: { kind: "refresh" } })).toBeNull();
		expect(ipc.removeHandler).toHaveBeenCalledTimes(2);
	});
});
