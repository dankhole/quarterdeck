import { z } from "zod";

export const runtimeCapabilitiesSchema = z.object({
	nativeUiAvailable: z.boolean(),
});
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;

export const runtimeOpenTargetPlatformSchema = z.enum(["mac", "windows", "linux", "other"]);
export type RuntimeOpenTargetPlatform = z.infer<typeof runtimeOpenTargetPlatformSchema>;

export const runtimeOpenTargetIdSchema = z.enum([
	"vscode",
	"vscode-insiders",
	"cursor",
	"windsurf",
	"finder",
	"terminal",
	"iterm2",
	"ghostty",
	"warp",
	"xcode",
	"intellijidea",
	"rider",
	"zed",
]);
export type RuntimeOpenTargetId = z.infer<typeof runtimeOpenTargetIdSchema>;

export const RUNTIME_OPEN_TARGET_IDS_BY_PLATFORM = {
	mac: [
		"vscode",
		"cursor",
		"windsurf",
		"finder",
		"terminal",
		"iterm2",
		"ghostty",
		"warp",
		"xcode",
		"intellijidea",
		"rider",
		"vscode-insiders",
		"zed",
	],
	windows: ["vscode", "cursor", "windsurf", "finder", "rider", "vscode-insiders", "zed"],
	linux: ["vscode", "cursor", "windsurf", "finder", "rider", "vscode-insiders", "zed"],
	other: ["vscode", "vscode-insiders", "finder"],
} as const satisfies Record<RuntimeOpenTargetPlatform, readonly RuntimeOpenTargetId[]>;

export const runtimeHostIntegrationFailureReasonSchema = z.enum([
	"native_ui_unavailable",
	"launcher_unavailable",
	"launch_failed",
]);
export type RuntimeHostIntegrationFailureReason = z.infer<typeof runtimeHostIntegrationFailureReasonSchema>;

export const runtimeHostIntegrationActionResponseSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
	}),
	z.object({
		ok: z.literal(false),
		reason: runtimeHostIntegrationFailureReasonSchema,
		error: z.string(),
	}),
]);
export type RuntimeHostIntegrationActionResponse = z.infer<typeof runtimeHostIntegrationActionResponseSchema>;
