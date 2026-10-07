import { writeFile } from "node:fs/promises";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
	type DesktopDraftSaveRequest,
	type DesktopDraftSaveResponse,
	desktopDraftSaveRequestSchema,
} from "../../src/shared/desktop-bridge-contract.js";
import { DESKTOP_DRAFT_SAVE_CHANNEL } from "./desktop-ipc-channels.js";
import { type ApprovedRenderer, isApprovedDocumentSender } from "./renderer-admission.js";

export { DESKTOP_DRAFT_SAVE_CHANNEL } from "./desktop-ipc-channels.js";

interface DraftSaveOptions {
	ipc: Pick<IpcMain, "handle" | "removeHandler">;
	getRenderer: () => ApprovedRenderer | null;
	choosePath: (request: DesktopDraftSaveRequest) => Promise<string | null>;
	write?: (path: string, content: string) => Promise<void>;
}

/** A bounded recovery export writes only the filename chosen in a parented native save dialog. */
export function installEditorDraftSave(options: DraftSaveOptions): () => void {
	let pending = false;
	options.ipc.handle(
		DESKTOP_DRAFT_SAVE_CHANNEL,
		async (event: IpcMainInvokeEvent, payload: unknown): Promise<DesktopDraftSaveResponse> => {
			const renderer = options.getRenderer();
			const generation = renderer?.generation ?? null;
			const documentId = renderer?.documentId;
			if (
				pending ||
				!documentId ||
				!isApprovedDocumentSender(event, renderer, generation) ||
				!payload ||
				typeof payload !== "object" ||
				Array.isArray(payload)
			)
				return { kind: "failed" };
			const envelope = payload as Record<string, unknown>;
			if (
				Object.keys(envelope).length !== 3 ||
				envelope.runtimeGeneration !== generation ||
				envelope.documentId !== documentId
			)
				return { kind: "failed" };
			const request = desktopDraftSaveRequestSchema.safeParse(envelope.request);
			if (!request.success) return { kind: "failed" };
			pending = true;
			try {
				const path = await options.choosePath(request.data);
				if (!path) return { kind: "cancelled" };
				if (
					options.getRenderer()?.documentId !== documentId ||
					!isApprovedDocumentSender(event, options.getRenderer(), generation)
				)
					return { kind: "failed" };
				await (
					options.write ??
					((destination, content) => writeFile(destination, content, { encoding: "utf8", mode: 0o600 }))
				)(path, request.data.content);
				return { kind: "saved" };
			} catch {
				return { kind: "failed" };
			} finally {
				pending = false;
			}
		},
	);
	return () => options.ipc.removeHandler(DESKTOP_DRAFT_SAVE_CHANNEL);
}
