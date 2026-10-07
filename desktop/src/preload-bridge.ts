import {
	type DesktopBootstrap,
	type DesktopBridge,
	desktopAppCommandSchema,
	desktopCommandAvailabilitySchema,
	desktopDraftSaveRequestSchema,
	desktopDraftSaveResponseSchema,
	desktopNotificationContextSchema,
	desktopNotificationTargetSchema,
	desktopPreflightReleaseSchema,
	desktopProjectOpenRequestSchema,
	desktopQuitPreflightRequestSchema,
	desktopQuitPreflightResponseSchema,
	QUARTERDECK_DESKTOP_BRIDGE_VERSION,
} from "../../src/shared/desktop-bridge-contract.js";
import {
	DESKTOP_AVAILABILITY_CHANNEL,
	DESKTOP_COMMAND_CHANNEL,
	DESKTOP_DRAFT_SAVE_CHANNEL,
	DESKTOP_NOTIFICATION_CONTEXT_CHANNEL,
	DESKTOP_NOTIFICATION_TARGET_CHANNEL,
	DESKTOP_PREFLIGHT_CHANNEL,
	DESKTOP_PREFLIGHT_RELEASE_CHANNEL,
	DESKTOP_PREFLIGHT_REPLY_CHANNEL,
	DESKTOP_PROJECT_OPEN_CHANNEL,
} from "./desktop-ipc-channels.js";

interface PreloadIpc {
	on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
	removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
	send: (channel: string, payload: unknown) => void;
	invoke: (channel: string, payload: unknown) => Promise<unknown>;
}

export function createDesktopBridge(bootstrap: DesktopBootstrap, ipc: PreloadIpc, documentId: string): DesktopBridge {
	const generation = bootstrap.runtimeGeneration;
	return Object.freeze({
		version: QUARTERDECK_DESKTOP_BRIDGE_VERSION,
		bootstrap: Object.freeze({ ...bootstrap, capabilities: Object.freeze({ ...bootstrap.capabilities }) }),
		publishCommandAvailability: (availability) => {
			const parsed = desktopCommandAvailabilitySchema.safeParse(availability);
			if (parsed.success && parsed.data.runtimeGeneration === generation)
				ipc.send(DESKTOP_AVAILABILITY_CHANNEL, {
					documentId,
					runtimeGeneration: generation,
					availability: parsed.data,
				});
		},
		reportNotificationContext: (context) => {
			const parsed = desktopNotificationContextSchema.safeParse(context);
			if (parsed.success)
				ipc.send(DESKTOP_NOTIFICATION_CONTEXT_CHANNEL, {
					documentId,
					runtimeGeneration: generation,
					context: parsed.data,
				});
		},
		onNotificationTarget: (listener) => {
			const callback = (_event: unknown, payload: unknown): void => {
				const target = desktopNotificationTargetSchema.safeParse(payload);
				if (target.success && target.data.runtimeGeneration === generation) listener(target.data);
			};
			ipc.on(DESKTOP_NOTIFICATION_TARGET_CHANNEL, callback);
			return () => ipc.removeListener(DESKTOP_NOTIFICATION_TARGET_CHANNEL, callback);
		},
		onCommand: (listener) => {
			const callback = (_event: unknown, payload: unknown): void => {
				const command = desktopAppCommandSchema.safeParse(payload);
				if (command.success && command.data.runtimeGeneration === generation) listener(command.data);
			};
			ipc.on(DESKTOP_COMMAND_CHANNEL, callback);
			return () => ipc.removeListener(DESKTOP_COMMAND_CHANNEL, callback);
		},
		onOpenProject: (listener) => {
			const callback = (_event: unknown, payload: unknown): void => {
				const request = desktopProjectOpenRequestSchema.safeParse(payload);
				if (request.success && request.data.runtimeGeneration === generation) listener(request.data);
			};
			ipc.on(DESKTOP_PROJECT_OPEN_CHANNEL, callback);
			return () => ipc.removeListener(DESKTOP_PROJECT_OPEN_CHANNEL, callback);
		},
		onQuitPreflight: (listener) => {
			const callback = (_event: unknown, payload: unknown): void => {
				const request = desktopQuitPreflightRequestSchema.safeParse(payload);
				if (request.success && request.data.runtimeGeneration === generation) listener(request.data);
			};
			ipc.on(DESKTOP_PREFLIGHT_CHANNEL, callback);
			return () => ipc.removeListener(DESKTOP_PREFLIGHT_CHANNEL, callback);
		},
		respondQuitPreflight: (response) => {
			const parsed = desktopQuitPreflightResponseSchema.safeParse(response);
			if (parsed.success && parsed.data.runtimeGeneration === generation)
				ipc.send(DESKTOP_PREFLIGHT_REPLY_CHANNEL, { documentId, response: parsed.data });
		},
		onPreflightReleased: (listener) => {
			const callback = (_event: unknown, payload: unknown): void => {
				const release = desktopPreflightReleaseSchema.safeParse(payload);
				if (release.success && release.data.runtimeGeneration === generation) listener(release.data);
			};
			ipc.on(DESKTOP_PREFLIGHT_RELEASE_CHANNEL, callback);
			return () => ipc.removeListener(DESKTOP_PREFLIGHT_RELEASE_CHANNEL, callback);
		},
		saveEditorDraft: async (request) => {
			const parsed = desktopDraftSaveRequestSchema.safeParse(request);
			if (!parsed.success) return { kind: "failed" };
			try {
				const response = desktopDraftSaveResponseSchema.safeParse(
					await ipc.invoke(DESKTOP_DRAFT_SAVE_CHANNEL, {
						runtimeGeneration: generation,
						documentId,
						request: parsed.data,
					}),
				);
				return response.success ? response.data : { kind: "failed" };
			} catch {
				return { kind: "failed" };
			}
		},
	} satisfies DesktopBridge);
}
