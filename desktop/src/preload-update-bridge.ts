import type { DesktopBootstrap } from "../../src/shared/desktop-bridge-contract.js";
import {
	type DesktopUpdateBridge,
	type DesktopUpdateSnapshot,
	desktopUpdateIntentSchema,
	QUARTERDECK_DESKTOP_UPDATE_BRIDGE_VERSION,
} from "../../src/shared/desktop-update-contract.js";
import {
	DESKTOP_UPDATE_INTENT_CHANNEL,
	DESKTOP_UPDATE_SNAPSHOT_CHANNEL,
	DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL,
} from "./desktop-ipc-channels.js";
import type { PreloadIpc } from "./preload-bridge.js";
import { desktopUpdatePublicationSchema } from "./update-ipc-contract.js";

/** An optional namespace preserves the original bridge's exact version-one shape. */
export function createDesktopUpdateBridge(
	bootstrap: DesktopBootstrap,
	ipc: PreloadIpc,
	documentId: string,
): DesktopUpdateBridge {
	const generation = bootstrap.runtimeGeneration;
	const identity = { documentId, runtimeGeneration: generation };
	let revision = -1;
	let snapshot: DesktopUpdateSnapshot | null = null;
	const listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>();
	const accept = (payload: unknown): DesktopUpdateSnapshot | null => {
		const parsed = desktopUpdatePublicationSchema.safeParse(payload);
		if (!parsed.success || parsed.data.runtimeGeneration !== generation || parsed.data.documentId !== documentId)
			return null;
		if (parsed.data.revision > revision) {
			revision = parsed.data.revision;
			snapshot = Object.freeze(parsed.data.snapshot);
			for (const listener of listeners) listener(snapshot);
		}
		return snapshot;
	};
	const onUpdate = (_event: unknown, payload: unknown): void => {
		accept(payload);
	};
	return Object.freeze({
		version: QUARTERDECK_DESKTOP_UPDATE_BRIDGE_VERSION,
		getSnapshot: async () => {
			try {
				return accept(await ipc.invoke(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, identity));
			} catch {
				return null;
			}
		},
		onSnapshot: (listener) => {
			const first = listeners.size === 0;
			listeners.add(listener);
			if (first) {
				ipc.on(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, onUpdate);
				ipc.send(DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL, { ...identity, subscribed: true });
			}
			return () => {
				if (!listeners.delete(listener) || listeners.size !== 0) return;
				ipc.removeListener(DESKTOP_UPDATE_SNAPSHOT_CHANNEL, onUpdate);
				ipc.send(DESKTOP_UPDATE_SUBSCRIPTION_CHANNEL, { ...identity, subscribed: false });
			};
		},
		request: async (intent) => {
			const parsed = desktopUpdateIntentSchema.safeParse(intent);
			if (!parsed.success) return;
			try {
				await ipc.invoke(DESKTOP_UPDATE_INTENT_CHANNEL, { ...identity, intent: parsed.data });
			} catch {
				// Native presentation owns action errors; main-process details never enter the renderer.
			}
		},
	} satisfies DesktopUpdateBridge);
}
