import { z } from "zod";

export const desktopEnvironmentFailureReasonSchema = z.enum([
	"unsupported_shell",
	"capture_failed",
	"capture_timeout",
	"capture_output_limit",
	"capture_invalid",
]);

const directoriesSchema = z.array(z.string().min(1).max(4096)).max(16);
export const desktopEnvironmentSnapshotSchema = z.strictObject({
	ownership: z.enum(["owned", "attached", "none"]),
	source: z.enum(["inherited", "login-shell", "fallback", "unresolved"]),
	failureReason: desktopEnvironmentFailureReasonSchema.nullable(),
	appliedDirectories: directoriesSchema,
	appliedImportLoginShellEnvironment: z.boolean().nullable(),
	preferences: z
		.strictObject({
			importLoginShellEnvironment: z.boolean(),
			extraExecutableDirectories: directoriesSchema,
		})
		.nullable(),
});
export type DesktopEnvironmentSnapshot = z.infer<typeof desktopEnvironmentSnapshotSchema>;

/** Paths are chosen by the native picker; the renderer never supplies paths or environment values. */
export const desktopEnvironmentIntentSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("set-login-shell-import"), enabled: z.boolean() }),
	z.strictObject({ kind: z.literal("add-folders") }),
	z.strictObject({ kind: z.literal("reset-folders") }),
	z.strictObject({ kind: z.literal("reset-preferences") }),
	z.strictObject({ kind: z.literal("refresh") }),
]);
export type DesktopEnvironmentIntent = z.infer<typeof desktopEnvironmentIntentSchema>;

export const desktopEnvironmentResponseSchema = z.strictObject({
	outcome: z.enum(["saved", "refreshed", "cancelled", "incomplete", "failed", "unavailable"]),
	snapshot: desktopEnvironmentSnapshotSchema.nullable(),
});
export type DesktopEnvironmentResponse = z.infer<typeof desktopEnvironmentResponseSchema>;

/** Optional namespace keeps older runtime UIs compatible with the original desktop bridge. */
export const QUARTERDECK_DESKTOP_ENVIRONMENT_BRIDGE_VERSION = 1;
export interface DesktopEnvironmentBridge {
	readonly version: typeof QUARTERDECK_DESKTOP_ENVIRONMENT_BRIDGE_VERSION;
	readonly getSnapshot: () => Promise<DesktopEnvironmentSnapshot | null>;
	readonly request: (intent: DesktopEnvironmentIntent) => Promise<DesktopEnvironmentResponse>;
}
