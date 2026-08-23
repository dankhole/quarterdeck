import { z } from "zod";

export const runtimeHostIntegrationModeSchema = z.enum(["native", "unavailable", "simulated"]);
export type RuntimeHostIntegrationMode = z.infer<typeof runtimeHostIntegrationModeSchema>;

export const runtimeCapabilitiesSchema = z
	.object({
		nativeUiAvailable: z.boolean(),
		hostIntegrationMode: runtimeHostIntegrationModeSchema,
	})
	.superRefine((capabilities, context) => {
		if (capabilities.nativeUiAvailable !== (capabilities.hostIntegrationMode === "native")) {
			context.addIssue({
				code: "custom",
				message: "nativeUiAvailable must be true only when native host integrations are enabled.",
			});
		}
	});
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;

export function createRuntimeCapabilities(hostIntegrationMode: RuntimeHostIntegrationMode): RuntimeCapabilities {
	return {
		nativeUiAvailable: hostIntegrationMode === "native",
		hostIntegrationMode,
	};
}

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
	"invalid_target",
]);
export type RuntimeHostIntegrationFailureReason = z.infer<typeof runtimeHostIntegrationFailureReasonSchema>;

export const runtimeHostIntegrationSuccessOutcomeSchema = z.enum(["native", "simulated"]);
export type RuntimeHostIntegrationSuccessOutcome = z.infer<typeof runtimeHostIntegrationSuccessOutcomeSchema>;

export const runtimeHostIntegrationActionResponseSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		outcome: runtimeHostIntegrationSuccessOutcomeSchema,
	}),
	z.object({
		ok: z.literal(false),
		reason: runtimeHostIntegrationFailureReasonSchema,
		error: z.string(),
	}),
]);
export type RuntimeHostIntegrationActionResponse = z.infer<typeof runtimeHostIntegrationActionResponseSchema>;

export const runtimeHostIntegrationEventKindSchema = z.enum([
	"directory_picker",
	"external_url",
	"open_path",
	"open_project",
	"clipboard_read",
	"clipboard_write",
	"notification_audio",
]);
export type RuntimeHostIntegrationEventKind = z.infer<typeof runtimeHostIntegrationEventKindSchema>;

export const MAX_RUNTIME_HOST_INTEGRATION_EVENTS = 1_000;
export const MAX_RUNTIME_HOST_INTEGRATION_URL_LENGTH = 2_048;

export const runtimeHostIntegrationSanitizedPathSchema = z.object({
	scope: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
	relativePath: z.string().max(1024),
});
export type RuntimeHostIntegrationSanitizedPath = z.infer<typeof runtimeHostIntegrationSanitizedPathSchema>;

export const runtimeHostIntegrationSanitizedUrlSchema = z.string().url().max(MAX_RUNTIME_HOST_INTEGRATION_URL_LENGTH);

const runtimeHostIntegrationEventBaseFields = {
	sequence: z.number().int().positive(),
	timestamp: z.string().datetime(),
	origin: z.enum(["runtime", "browser"]),
} as const;

export const runtimeHostIntegrationEventSchema = z.discriminatedUnion("kind", [
	z.object({
		...runtimeHostIntegrationEventBaseFields,
		kind: z.literal("directory_picker"),
		outcome: z.literal("unsupported"),
	}),
	z.object({
		...runtimeHostIntegrationEventBaseFields,
		kind: z.literal("external_url"),
		outcome: z.literal("simulated"),
		url: runtimeHostIntegrationSanitizedUrlSchema,
	}),
	z.object({
		...runtimeHostIntegrationEventBaseFields,
		kind: z.literal("open_path"),
		outcome: z.literal("simulated"),
		target: runtimeHostIntegrationSanitizedPathSchema,
		projectId: z.string().max(128).nullable(),
		taskId: z.string().max(128).nullable(),
	}),
	z.object({
		...runtimeHostIntegrationEventBaseFields,
		kind: z.literal("open_project"),
		outcome: z.literal("simulated"),
		targetId: runtimeOpenTargetIdSchema,
		target: runtimeHostIntegrationSanitizedPathSchema,
		projectId: z.string().max(128).nullable(),
	}),
	z.object({
		...runtimeHostIntegrationEventBaseFields,
		kind: z.literal("clipboard_read"),
		outcome: z.literal("simulated"),
		characterCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	}),
	z.object({
		...runtimeHostIntegrationEventBaseFields,
		kind: z.literal("clipboard_write"),
		outcome: z.literal("simulated"),
		characterCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	}),
	z.object({
		...runtimeHostIntegrationEventBaseFields,
		kind: z.literal("notification_audio"),
		outcome: z.literal("simulated"),
		eventType: z.enum(["permission", "review", "failure"]),
		volume: z.number().min(0).max(1),
		projectId: z.string().max(128).nullable(),
		taskId: z.string().max(128).nullable(),
	}),
]);
export type RuntimeHostIntegrationEvent = z.infer<typeof runtimeHostIntegrationEventSchema>;

export const runtimeBrowserHostIntegrationEventRequestSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("clipboard_read"),
		characterCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	}),
	z.object({
		kind: z.literal("clipboard_write"),
		characterCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	}),
	z.object({
		kind: z.literal("notification_audio"),
		eventType: z.enum(["permission", "review", "failure"]),
		volume: z.number().min(0).max(1),
		projectId: z.string().max(128).nullable(),
		taskId: z.string().max(128).nullable(),
	}),
]);
export type RuntimeBrowserHostIntegrationEventRequest = z.infer<typeof runtimeBrowserHostIntegrationEventRequestSchema>;

export const runtimeHostIntegrationEventLedgerResponseSchema = z.object({
	events: z.array(runtimeHostIntegrationEventSchema).max(MAX_RUNTIME_HOST_INTEGRATION_EVENTS),
	lastSequence: z.number().int().nonnegative(),
});
export type RuntimeHostIntegrationEventLedgerResponse = z.infer<typeof runtimeHostIntegrationEventLedgerResponseSchema>;

export const runtimeHostIntegrationEventLedgerFileSchema = runtimeHostIntegrationEventLedgerResponseSchema.extend({
	schemaVersion: z.literal(1),
});
export type RuntimeHostIntegrationEventLedgerFile = z.infer<typeof runtimeHostIntegrationEventLedgerFileSchema>;
