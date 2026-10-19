import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import {
	type DesktopUpdateIntent,
	type DesktopUpdateSnapshot,
	desktopUpdateSnapshotSchema,
} from "../../src/shared/desktop-update-contract.js";
import {
	DESKTOP_UPDATE_INTENT_CHANNEL,
	DESKTOP_UPDATE_SNAPSHOT_CHANNEL,
	DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL,
} from "./desktop-ipc-channels.js";
import { type ApprovedRenderer, isApprovedDocumentSender } from "./renderer-admission.js";
import {
	desktopUpdateDocumentSchema,
	desktopUpdateRequestSchema,
	desktopUpdateSubscriptionSchema,
} from "./update-ipc-contract.js";

interface DesktopUpdateIpcOptions {
	ipc: Pick<IpcMain, "handle" | "removeHandler" | "on" | "removeListener">;
	getRenderer: () => ApprovedRenderer | null;
	getSnapshot: () => DesktopUpdateSnapshot;
	subscribe: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void;
	request: (intent: DesktopUpdateIntent) => void | Promise<void>;
}

type DocumentIdentity = { runtimeGeneration: string; documentId: string };
type Sender = Pick<IpcMainEvent, "sender" | "senderFrame">;

/** Main owns every target and effect; the renderer can only request two fixed native actions. */
export function installDesktopUpdateIpc(options: DesktopUpdateIpcOptions): () => void {
	let disposed = false;
	let revision = 0;
	let subscription: { sender: Sender; identity: DocumentIdentity } | null = null;
	const admitted = (sender: Sender, identity: DocumentIdentity): boolean => {
		const renderer = options.getRenderer();
		return (
			!disposed &&
			renderer?.documentId === identity.documentId &&
			isApprovedDocumentSender(sender, renderer, identity.runtimeGeneration)
		);
	};
	const publication = (identity: DocumentIdentity, snapshot: DesktopUpdateSnapshot) => {
		const parsed = desktopUpdateSnapshotSchema.safeParse(snapshot);
		return parsed.success ? { ...identity, revision, snapshot: parsed.data } : null;
	};
	const onSubscription = (event: IpcMainEvent, payload: unknown): void => {
		const parsed = desktopUpdateSubscriptionSchema.safeParse(payload);
		if (!parsed.success || !admitted(event, parsed.data)) return;
		subscription = parsed.data.subscribed
			? {
					sender: { sender: event.sender, senderFrame: event.senderFrame },
					identity: { runtimeGeneration: parsed.data.runtimeGeneration, documentId: parsed.data.documentId },
				}
			: null;
	};
	options.ipc.on(DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL, onSubscription);
	options.ipc.handle(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
		const parsed = desktopUpdateDocumentSchema.safeParse(payload);
		return parsed.success && admitted(event, parsed.data) ? publication(parsed.data, options.getSnapshot()) : null;
	});
	options.ipc.handle(
		DESKTOP_UPDATE_INTENT_CHANNEL,
		async (event: IpcMainInvokeEvent, payload: unknown): Promise<boolean> => {
			const parsed = desktopUpdateRequestSchema.safeParse(payload);
			if (!parsed.success || !admitted(event, parsed.data)) return false;
			try {
				await options.request(parsed.data.intent);
				return true;
			} catch {
				return false;
			}
		},
	);
	const unsubscribe = options.subscribe((snapshot) => {
		if (disposed) return;
		revision += 1;
		if (!subscription) return;
		if (!admitted(subscription.sender, subscription.identity)) {
			subscription = null;
			return;
		}
		const payload = publication(subscription.identity, snapshot);
		if (!payload) return;
		try {
			subscription.sender.sender.send(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, payload);
		} catch {
			// A renderer destroyed during delivery has no remaining update subscription.
			subscription = null;
		}
	});
	return () => {
		if (disposed) return;
		disposed = true;
		subscription = null;
		unsubscribe();
		options.ipc.removeListener(DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL, onSubscription);
		options.ipc.removeHandler(DESKTOP_UPDATE_SNAPSHOT_CHANNEL);
		options.ipc.removeHandler(DESKTOP_UPDATE_INTENT_CHANNEL);
	};
}
