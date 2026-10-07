import { z } from "zod";
import { QUARTERDECK_DESKTOP_BRIDGE_VERSION } from "../../shared/desktop-bridge-contract.js";
import { desktopDiagnosticsPayloadSchema } from "./desktop-diagnostics.js";
import { runtimeOpenTargetIdSchema } from "./host-integrations.js";
import { runtimeShutdownOutcomeSchema } from "./runtime-shutdown.js";

/** Private parent/Node-helper channel. These messages never enter a renderer. */
export const QUARTERDECK_DESKTOP_RUNTIME_PROTOCOL_VERSION = 1;
export const QUARTERDECK_DESKTOP_TRANSPORT_VERSION = 1;
export const QUARTERDECK_DESKTOP_ORIGIN = "app://quarterdeck";
export const QUARTERDECK_DESKTOP_TOKEN_HEADER = "x-quarterdeck-desktop-token";

const channelIdentity = {
	protocolVersion: z.literal(QUARTERDECK_DESKTOP_RUNTIME_PROTOCOL_VERSION),
	startupId: z.string().uuid(),
};

export const desktopRuntimeOriginSchema = z.string().refine((value) => {
	try {
		const url = new URL(value);
		return (
			url.protocol === "http:" &&
			url.hostname === "127.0.0.1" &&
			url.username === "" &&
			url.password === "" &&
			url.port !== "" &&
			url.origin === value
		);
	} catch {
		return false;
	}
}, "Expected a canonical loopback runtime origin.");

export const desktopStartupMessageSchema = z
	.object({
		type: z.literal("quarterdeck:desktop-startup"),
		...channelIdentity,
		clientToken: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
		allowedOrigins: z.tuple([z.literal(QUARTERDECK_DESKTOP_ORIGIN)]),
	})
	.strict();
export type DesktopStartupMessage = z.infer<typeof desktopStartupMessageSchema>;

export const desktopReadyMessageSchema = z
	.object({
		type: z.literal("quarterdeck:desktop-ready"),
		...channelIdentity,
		runtimeOrigin: desktopRuntimeOriginSchema,
		runtimeGeneration: z.string().uuid(),
		instanceId: z.string().min(1).max(128),
		// Diagnostic identity is separate from runtime custody; attached clients export their own main journal.
		diagnosticInstanceId: z.string().uuid().nullable(),
		browserProtocolVersion: z.number().int().positive(),
		packageVersion: z.string().min(1).max(64),
		desktopBridgeVersion: z.literal(QUARTERDECK_DESKTOP_BRIDGE_VERSION),
		desktopTransportVersion: z.literal(QUARTERDECK_DESKTOP_TRANSPORT_VERSION),
		ownership: z.enum(["owned", "attached"]),
	})
	.strict();
export type DesktopReadyMessage = z.infer<typeof desktopReadyMessageSchema>;

export const desktopShutdownMessageSchema = z
	.object({
		type: z.literal("quarterdeck:desktop-shutdown"),
		...channelIdentity,
		requestId: z.string().uuid(),
	})
	.strict();
export type DesktopShutdownMessage = z.infer<typeof desktopShutdownMessageSchema>;

export const desktopShutdownResultMessageSchema = z
	.object({
		type: z.literal("quarterdeck:desktop-shutdown-result"),
		...channelIdentity,
		requestId: z.string().uuid(),
		outcome: runtimeShutdownOutcomeSchema,
	})
	.strict();
export type DesktopShutdownResultMessage = z.infer<typeof desktopShutdownResultMessageSchema>;

export const desktopStartupFailureMessageSchema = z
	.object({
		type: z.literal("quarterdeck:desktop-failed"),
		...channelIdentity,
		code: z.enum([
			"ownership_unavailable",
			"incompatible_runtime",
			"startup_failed",
			"recovery_custody_unconfirmed",
			"recovery_evidence_unverifiable",
			"prior_processes_live",
			"identity_unavailable",
		]),
		message: z.string().min(1).max(1024),
	})
	.strict();
export type DesktopStartupFailureMessage = z.infer<typeof desktopStartupFailureMessageSchema>;

export const desktopControlMessageSchema = z
	.object({
		type: z.literal("quarterdeck:desktop-control"),
		...channelIdentity,
		requestId: z.string().uuid(),
		method: z.enum(["get-quit-summary", "create-browser-launch"]),
	})
	.strict();
export type DesktopControlMessage = z.infer<typeof desktopControlMessageSchema>;

export const desktopQuitSummarySchema = z
	.object({
		method: z.literal("get-quit-summary"),
		owned: z.boolean(),
		liveProcessCount: z.number().int().nonnegative(),
		pendingLaunches: z.boolean(),
	})
	.strict();
export type DesktopQuitSummary = z.infer<typeof desktopQuitSummarySchema>;

export const desktopControlResultMessageSchema = z
	.object({
		type: z.literal("quarterdeck:desktop-control-result"),
		...channelIdentity,
		requestId: z.string().uuid(),
		result: z.discriminatedUnion("method", [
			desktopQuitSummarySchema,
			z.object({ method: z.literal("create-browser-launch"), url: z.string().url() }).strict(),
			z.object({ method: z.literal("failed"), code: z.literal("unavailable") }).strict(),
		]),
	})
	.strict();
export type DesktopControlResultMessage = z.infer<typeof desktopControlResultMessageSchema>;

const desktopHostPathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => value.startsWith("/") && !value.includes("\0"));
export const desktopHostExternalUrlSchema = z
	.string()
	.min(1)
	.max(8192)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				["https:", "http:", "mailto:"].includes(url.protocol) &&
				!url.username &&
				!url.password &&
				!Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
			);
		} catch {
			return false;
		}
	});

export const desktopHostEffectActionSchema = z.discriminatedUnion("method", [
	z.object({ method: z.literal("pick-directory") }).strict(),
	z.object({ method: z.literal("open-path"), path: desktopHostPathSchema }).strict(),
	z.object({ method: z.literal("open-external-url"), url: desktopHostExternalUrlSchema }).strict(),
	z
		.object({ method: z.literal("open-project"), targetId: runtimeOpenTargetIdSchema, path: desktopHostPathSchema })
		.strict(),
]);
export type DesktopHostEffectAction = z.infer<typeof desktopHostEffectActionSchema>;

export const desktopHostEffectResultSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("selected"), path: desktopHostPathSchema }).strict(),
	z.object({ status: z.literal("cancelled") }).strict(),
	z.object({ status: z.literal("opened") }).strict(),
	z
		.object({
			status: z.literal("failed"),
			reason: z.enum(["denied", "unavailable", "launch_failed", "timeout", "busy", "disconnected"]),
		})
		.strict(),
]);
export type DesktopHostEffectResult = z.infer<typeof desktopHostEffectResultSchema>;

const hostEffectIdentity = {
	...channelIdentity,
	runtimeGeneration: z.string().uuid(),
	requestId: z.string().uuid(),
	sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const desktopHostEffectRequestMessageSchema = z
	.object({
		type: z.literal("quarterdeck:desktop-host-request"),
		...hostEffectIdentity,
		action: desktopHostEffectActionSchema,
	})
	.strict();
export type DesktopHostEffectRequestMessage = z.infer<typeof desktopHostEffectRequestMessageSchema>;

export const desktopHostEffectResultMessageSchema = z
	.object({
		type: z.literal("quarterdeck:desktop-host-result"),
		...hostEffectIdentity,
		result: desktopHostEffectResultSchema,
	})
	.strict();
export type DesktopHostEffectResultMessage = z.infer<typeof desktopHostEffectResultMessageSchema>;

export const desktopDiagnosticsMessageSchema = z
	.object({
		type: z.literal("quarterdeck:desktop-diagnostics"),
		...channelIdentity,
		payload: desktopDiagnosticsPayloadSchema,
	})
	.strict();
export type DesktopDiagnosticsMessage = z.infer<typeof desktopDiagnosticsMessageSchema>;

export const desktopParentMessageSchema = z.discriminatedUnion("type", [
	desktopStartupMessageSchema,
	desktopShutdownMessageSchema,
	desktopControlMessageSchema,
	desktopHostEffectResultMessageSchema,
	desktopDiagnosticsMessageSchema,
]);
export const desktopChildMessageSchema = z.discriminatedUnion("type", [
	desktopReadyMessageSchema,
	desktopShutdownResultMessageSchema,
	desktopStartupFailureMessageSchema,
	desktopControlResultMessageSchema,
	desktopHostEffectRequestMessageSchema,
]);
