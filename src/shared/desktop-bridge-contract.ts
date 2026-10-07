import { z } from "zod";
import { desktopLaunchPathSchema } from "./desktop-launch-contract.js";

/** Desktop preload contract. This is independent of the browser/runtime protocol. */
export const QUARTERDECK_DESKTOP_BRIDGE_VERSION = 1;

export interface DesktopCapabilities {
	readonly desktop: true;
	readonly nativeDialogs: boolean;
	readonly nativeNotifications: boolean;
}

/** Non-secret, fixed for the lifetime of the loaded document. */
export interface DesktopBootstrap {
	readonly runtimeOrigin: string;
	readonly runtimeGeneration: string;
	readonly capabilities: DesktopCapabilities;
}

const desktopIdentitySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);

export const desktopAppCommandNameSchema = z.enum([
	"settings",
	"diagnostics",
	"new-task",
	"open-project",
	"home",
	"files",
	"git",
	"terminal",
	"file-finder",
	"text-search",
	"toggle-shell",
]);
export const desktopAppCommandSchema = z.strictObject({
	runtimeGeneration: desktopIdentitySchema,
	command: desktopAppCommandNameSchema,
});
export const desktopCommandAvailabilitySchema = z.strictObject({
	runtimeGeneration: desktopIdentitySchema,
	commands: z
		.array(desktopAppCommandNameSchema)
		.max(11)
		.refine((commands) => new Set(commands).size === commands.length),
	runtimeConnected: z.boolean(),
	/** Absent in older frontends; false retains npm intent during transient initialization. */
	projectLaunchReady: z.boolean().optional(),
});
export type DesktopCommandAvailability = z.infer<typeof desktopCommandAvailabilitySchema>;

export type DesktopAppCommand = z.infer<typeof desktopAppCommandSchema>;

export const desktopProjectOpenRequestSchema = z.strictObject({
	runtimeGeneration: desktopIdentitySchema,
	projectPath: desktopLaunchPathSchema,
});
export type DesktopProjectOpenRequest = z.infer<typeof desktopProjectOpenRequestSchema>;

export const desktopNotificationTargetSchema = z
	.strictObject({
		runtimeGeneration: desktopIdentitySchema,
		projectId: desktopIdentitySchema.nullable(),
		taskId: desktopIdentitySchema.nullable(),
	})
	.refine((target) => target.taskId === null || target.projectId !== null);
export type DesktopNotificationTarget = z.infer<typeof desktopNotificationTargetSchema>;

export const desktopNotificationContextSchema = z.strictObject({
	currentProjectId: desktopIdentitySchema.nullable(),
});
export type DesktopNotificationContext = z.infer<typeof desktopNotificationContextSchema>;

export const desktopQuitPreflightRequestSchema = z
	.strictObject({
		requestId: desktopIdentitySchema,
		runtimeGeneration: desktopIdentitySchema,
		reason: z.enum(["quit", "update", "reload"]),
		/** Bounded admission deadline; ordinary quit/update seals also expire at this time. */
		freezeUntil: z.number().int().positive().optional(),
		/** Replacement navigation retains input capture until exact cancellation or document destruction. */
		freezeMode: z.literal("navigation").optional(),
	})
	.refine(
		(request) =>
			request.freezeMode === undefined || (request.reason === "reload" && request.freezeUntil !== undefined),
	);
export type DesktopQuitPreflightRequest = z.infer<typeof desktopQuitPreflightRequestSchema>;

export const desktopFrontendStatusSchema = z.strictObject({
	dirtyEditorCount: z.number().int().min(0).max(1_000_000),
	activeSessionCount: z.number().int().min(0).max(1_000_000),
	needsInputSessionCount: z.number().int().min(0).max(1_000_000),
	runtimeConnected: z.boolean(),
});
export type DesktopFrontendStatus = z.infer<typeof desktopFrontendStatusSchema>;

/** This only clears the frontend veto for an already requested native action. */
export const desktopQuitPreflightResponseSchema = z
	.strictObject({
		requestId: desktopIdentitySchema,
		runtimeGeneration: desktopIdentitySchema,
		decision: z.enum(["ready", "blocked"]),
		status: desktopFrontendStatusSchema,
	})
	.refine((value) => value.decision !== "ready" || value.status.dirtyEditorCount === 0);
export type DesktopQuitPreflightResponse = z.infer<typeof desktopQuitPreflightResponseSchema>;

export const desktopPreflightReleaseSchema = z.strictObject({
	requestId: desktopIdentitySchema,
	runtimeGeneration: desktopIdentitySchema,
});
export type DesktopPreflightRelease = z.infer<typeof desktopPreflightReleaseSchema>;

export const DESKTOP_DRAFT_SAVE_MAX_BYTES = 10_485_760;
export const desktopDraftSaveRequestSchema = z.strictObject({
	suggestedName: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[^\\/\p{Cc}]+$/u)
		.refine((value) => value !== "." && value !== ".."),
	content: z
		.string()
		.max(DESKTOP_DRAFT_SAVE_MAX_BYTES)
		.refine((value) => new TextEncoder().encode(value).byteLength <= DESKTOP_DRAFT_SAVE_MAX_BYTES),
});
export type DesktopDraftSaveRequest = z.infer<typeof desktopDraftSaveRequestSchema>;
export const desktopDraftSaveResponseSchema = z.strictObject({ kind: z.enum(["saved", "cancelled", "failed"]) });
export type DesktopDraftSaveResponse = z.infer<typeof desktopDraftSaveResponseSchema>;

export interface DesktopBridge {
	readonly version: typeof QUARTERDECK_DESKTOP_BRIDGE_VERSION;
	readonly bootstrap: DesktopBootstrap;
	readonly publishCommandAvailability?: (availability: DesktopCommandAvailability) => void;
	readonly onNotificationTarget?: (listener: (target: DesktopNotificationTarget) => void) => () => void;
	readonly reportNotificationContext?: (context: DesktopNotificationContext) => void;
	readonly onCommand?: (listener: (command: DesktopAppCommand) => void) => () => void;
	readonly onOpenProject?: (listener: (request: DesktopProjectOpenRequest) => void) => () => void;
	readonly onQuitPreflight?: (listener: (request: DesktopQuitPreflightRequest) => void) => () => void;
	readonly respondQuitPreflight?: (response: DesktopQuitPreflightResponse) => void;
	readonly onPreflightReleased?: (listener: (release: DesktopPreflightRelease) => void) => () => void;
	readonly saveEditorDraft?: (request: DesktopDraftSaveRequest) => Promise<DesktopDraftSaveResponse>;
}
