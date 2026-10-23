import type { DesktopBootstrap } from "../../src/shared/desktop-bridge-contract.js";
import {
	type DesktopEnvironmentBridge,
	desktopEnvironmentIntentSchema,
	QUARTERDECK_DESKTOP_ENVIRONMENT_BRIDGE_VERSION,
} from "../../src/shared/desktop-environment-contract.js";
import { DESKTOP_ENVIRONMENT_INTENT_CHANNEL, DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL } from "./desktop-ipc-channels.js";
import { desktopEnvironmentPublicationSchema, desktopEnvironmentReplySchema } from "./environment-ipc-contract.js";
import type { PreloadIpc } from "./preload-bridge.js";

export function createDesktopEnvironmentBridge(
	bootstrap: DesktopBootstrap,
	ipc: PreloadIpc,
	documentId: string,
): DesktopEnvironmentBridge {
	const identity = { documentId, runtimeGeneration: bootstrap.runtimeGeneration };
	const matches = (value: typeof identity) =>
		value.documentId === documentId && value.runtimeGeneration === identity.runtimeGeneration;
	return Object.freeze({
		version: QUARTERDECK_DESKTOP_ENVIRONMENT_BRIDGE_VERSION,
		getSnapshot: async () => {
			try {
				const parsed = desktopEnvironmentPublicationSchema.safeParse(
					await ipc.invoke(DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL, identity),
				);
				return parsed.success && matches(parsed.data) ? parsed.data.snapshot : null;
			} catch {
				return null;
			}
		},
		request: async (intent) => {
			const unavailable = { outcome: "unavailable", snapshot: null } as const;
			const parsed = desktopEnvironmentIntentSchema.safeParse(intent);
			if (!parsed.success) return unavailable;
			try {
				const reply = desktopEnvironmentReplySchema.safeParse(
					await ipc.invoke(DESKTOP_ENVIRONMENT_INTENT_CHANNEL, { ...identity, intent: parsed.data }),
				);
				return reply.success && matches(reply.data) ? reply.data.response : unavailable;
			} catch {
				return unavailable;
			}
		},
	} satisfies DesktopEnvironmentBridge);
}
