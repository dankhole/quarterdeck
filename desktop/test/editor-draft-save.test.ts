import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_DRAFT_SAVE_CHANNEL, installEditorDraftSave } from "../src/editor-draft-save.js";
import { RuntimeSelection } from "../src/runtime-selection.js";

function fixture() {
	let handler: ((event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>) | null = null;
	const ipc = {
		handle: (channel: string, listener: typeof handler) => {
			expect(channel).toBe(DESKTOP_DRAFT_SAVE_CHANNEL);
			handler = listener;
		},
		removeHandler: vi.fn(),
	} as unknown as IpcMain;
	const contents = {
		mainFrame: { url: "app://quarterdeck/" } as WebFrameMain,
		isDestroyed: () => false,
	} as unknown as WebContents;
	const renderer = { contents, generation: "generation", documentId: "document" };
	const selection = new RuntimeSelection();
	selection.select({ generation: "generation", origin: "http://127.0.0.1:12345", clientToken: "a".repeat(43) });
	const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent;
	const choosePath = vi.fn(async (): Promise<string | null> => "/synthetic/user-chosen-draft.txt");
	const write = vi.fn(async () => undefined);
	installEditorDraftSave({ ipc, getRenderer: () => renderer, choosePath, write });
	const save = async (payload: unknown, sender = event) => {
		if (!handler) throw new Error("missing handler");
		return await handler(sender, payload);
	};
	const payload = {
		runtimeGeneration: "generation",
		documentId: "document",
		request: { suggestedName: "draft.txt", content: "synthetic recovery draft" },
	};
	return { save, payload, event, renderer, selection, choosePath, write };
}

describe("bounded native editor draft recovery", () => {
	it("writes only the native-selected destination and remains available after helper loss", async () => {
		const { save, payload, selection, write, choosePath } = fixture();
		selection.clear();
		expect(await save(payload)).toEqual({ kind: "saved" });
		expect(choosePath).toHaveBeenCalledWith(payload.request);
		expect(write).toHaveBeenCalledWith("/synthetic/user-chosen-draft.txt", payload.request.content);
	});
	it("rejects unapproved frames, stale document epochs, arbitrary paths, and unsafe basenames", async () => {
		const { save, payload, event, write, choosePath } = fixture();
		for (const input of [
			{ ...payload, documentId: "old" },
			{ ...payload, runtimeGeneration: "old" },
			{ ...payload, path: "/arbitrary" },
			{ ...payload, request: { ...payload.request, suggestedName: "../escape" } },
			{ ...payload, request: { ...payload.request, suggestedName: ".." } },
		])
			expect(await save(input)).toEqual({ kind: "failed" });
		expect(await save(payload, { ...event, senderFrame: null })).toEqual({ kind: "failed" });
		expect(choosePath).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});
	it("does not write a stale document's export after native dialog navigation", async () => {
		const { save, payload, renderer, choosePath, write } = fixture();
		choosePath.mockImplementation(async () => {
			renderer.documentId = "replacement";
			return "/synthetic/draft.txt";
		});
		expect(await save(payload)).toEqual({ kind: "failed" });
		expect(write).not.toHaveBeenCalled();
	});
	it("preserves cancellation without writing or discarding the draft", async () => {
		const { save, payload, choosePath, write } = fixture();
		choosePath.mockImplementation(async () => null);
		expect(await save(payload)).toEqual({ kind: "cancelled" });
		expect(write).not.toHaveBeenCalled();
	});
	it("enforces the UTF-8 byte bound before presenting a native dialog", async () => {
		const { save, payload, choosePath } = fixture();
		expect(await save({ ...payload, request: { ...payload.request, content: "é".repeat(5_242_881) } })).toEqual({
			kind: "failed",
		});
		expect(choosePath).not.toHaveBeenCalled();
	});
});
