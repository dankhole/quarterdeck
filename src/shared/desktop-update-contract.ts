import { z } from "zod";

export const desktopUpdateSnapshotSchema = z.strictObject({
	phase: z.enum(["disabled", "idle", "checking", "current", "available", "failed", "preparing", "quitting"]),
	installedVersion: z.string().max(96),
	availableVersion: z.string().max(96).nullable(),
	channel: z.enum(["latest", "preview"]).nullable(),
});
export type DesktopUpdateSnapshot = z.infer<typeof desktopUpdateSnapshotSchema>;
export const desktopUpdateIntentSchema = z.enum(["check", "details"]);
export type DesktopUpdateIntent = z.infer<typeof desktopUpdateIntentSchema>;

/** Separate from the original desktop bridge so older runtime UIs keep their exact bridge shape. */
export const QUARTERDECK_DESKTOP_UPDATE_BRIDGE_VERSION = 1;
export interface DesktopUpdateBridge {
	readonly version: typeof QUARTERDECK_DESKTOP_UPDATE_BRIDGE_VERSION;
	readonly getSnapshot: () => Promise<DesktopUpdateSnapshot | null>;
	readonly onSnapshot: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void;
	readonly request: (intent: DesktopUpdateIntent) => Promise<void>;
}
