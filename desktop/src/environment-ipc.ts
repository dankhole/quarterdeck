import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
	desktopEnvironmentResponseSchema,
	desktopEnvironmentSnapshotSchema,
} from "../../src/shared/desktop-environment-contract.js";
import { DESKTOP_ENVIRONMENT_INTENT_CHANNEL, DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL } from "./desktop-ipc-channels.js";
import type { DesktopEnvironmentController } from "./environment-controller.js";
import { desktopEnvironmentDocumentSchema, desktopEnvironmentRequestSchema } from "./environment-ipc-contract.js";
import { type ApprovedRenderer, isApprovedDocumentSender } from "./renderer-admission.js";

interface DesktopEnvironmentIpcOptions {
	ipc: Pick<IpcMain, "handle" | "removeHandler">;
	getRenderer: () => ApprovedRenderer | null;
	controller: Pick<DesktopEnvironmentController, "getSnapshot" | "request">;
}

/** Only the admitted current document can inspect metadata or submit fixed native environment intents. */
export function installDesktopEnvironmentIpc(options: DesktopEnvironmentIpcOptions): () => void {
	let disposed = false;
	const admitted = (event: IpcMainInvokeEvent, identity: { runtimeGeneration: string; documentId: string }) => {
		const renderer = options.getRenderer();
		return (
			!disposed &&
			renderer?.documentId === identity.documentId &&
			isApprovedDocumentSender(event, renderer, identity.runtimeGeneration)
		);
	};
	options.ipc.handle(DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL, async (event: IpcMainInvokeEvent, payload: unknown) => {
		const parsed = desktopEnvironmentDocumentSchema.safeParse(payload);
		if (!parsed.success || !admitted(event, parsed.data)) return null;
		try {
			const snapshot = desktopEnvironmentSnapshotSchema.safeParse(await options.controller.getSnapshot());
			return snapshot.success && admitted(event, parsed.data) ? { ...parsed.data, snapshot: snapshot.data } : null;
		} catch {
			return null;
		}
	});
	options.ipc.handle(DESKTOP_ENVIRONMENT_INTENT_CHANNEL, async (event: IpcMainInvokeEvent, payload: unknown) => {
		const parsed = desktopEnvironmentRequestSchema.safeParse(payload);
		if (!parsed.success || !admitted(event, parsed.data)) return null;
		const { intent, ...identity } = parsed.data;
		try {
			const response = desktopEnvironmentResponseSchema.safeParse(
				await options.controller.request(intent, () => admitted(event, identity)),
			);
			return response.success && admitted(event, identity) ? { ...identity, response: response.data } : null;
		} catch {
			return null;
		}
	});
	return () => {
		if (disposed) return;
		disposed = true;
		options.ipc.removeHandler(DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL);
		options.ipc.removeHandler(DESKTOP_ENVIRONMENT_INTENT_CHANNEL);
	};
}
