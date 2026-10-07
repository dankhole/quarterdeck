import { z } from "zod";

import { runtimeShutdownOutcomeSchema } from "./runtime-shutdown.js";

export const desktopDiagnosticSurfaceSchema = z.enum([
	"starting",
	"startup_failed",
	"runtime_failed",
	"renderer_failed",
	"shutdown_failed",
	"product",
]);

export const desktopDiagnosticGenerationPhaseSchema = z.enum([
	"not_started",
	"starting",
	"ready",
	"stopping",
	"stopped",
	"failed",
]);

export const desktopDiagnosticUpdateStatusSchema = z
	.object({
		phase: z.enum(["disabled", "idle", "checking", "downloading", "downloaded", "restarting", "error"]),
		pending: z.boolean(),
		reason: z
			.enum([
				"unsigned",
				"synthetic",
				"unsupported",
				"production_feed_disabled",
				"npm_managed",
				"update_failed",
				"shutdown_incomplete",
				"normal_quit",
				"restart_failed",
				"dialog_failed",
			])
			.optional(),
	})
	.strict();

export const desktopDiagnosticStateSchema = z
	.object({
		surface: desktopDiagnosticSurfaceSchema,
		quitting: z.boolean(),
		window: z.object({ present: z.boolean(), visible: z.boolean(), focused: z.boolean() }).strict(),
		runtime: z
			.object({
				phase: desktopDiagnosticGenerationPhaseSchema,
				helperPid: z.number().int().positive().safe().nullable(),
				generation: z.string().uuid().nullable(),
				ownership: z.enum(["owned", "attached"]).nullable(),
			})
			.strict(),
		update: desktopDiagnosticUpdateStatusSchema,
	})
	.strict();
export type DesktopDiagnosticState = z.infer<typeof desktopDiagnosticStateSchema>;

export const desktopDiagnosticEventSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("startup"),
			phase: z.enum(["requested", "configured", "bundle_validated", "environment_resolved", "ready", "failed"]),
			failureCode: z
				.enum([
					"configuration_invalid",
					"bundle_invalid",
					"environment_fallback",
					"helper_failed",
					"protocol_incompatible",
					"ownership_unavailable",
				])
				.optional(),
			environmentSource: z.enum(["inherited", "login-shell", "fallback"]).optional(),
			durationMs: z.number().nonnegative().max(86_400_000).optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("lifecycle"),
			action: z.enum([
				"activate",
				"second_instance",
				"window_created",
				"window_hidden",
				"window_restored",
				"renderer_failed",
				"surface_changed",
				"sleep",
				"wake",
			]),
			surface: desktopDiagnosticSurfaceSchema.optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("generation"),
			phase: desktopDiagnosticGenerationPhaseSchema,
			helperPid: z.number().int().positive().safe().nullable(),
			generation: z.string().uuid().nullable(),
			ownership: z.enum(["owned", "attached"]).optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("shutdown"),
			phase: z.enum(["requested", "completed", "cancelled", "failed"]),
			intent: z.enum(["quit", "update", "retry"]).optional(),
			exitMode: z.enum(["clean", "forced_unconfirmed"]).optional(),
			outcome: runtimeShutdownOutcomeSchema.optional(),
		})
		.strict(),
	z.object({ kind: z.literal("update"), status: desktopDiagnosticUpdateStatusSchema }).strict(),
]);
export type DesktopDiagnosticEvent = z.infer<typeof desktopDiagnosticEventSchema>;

/** Safe event and observed state are retained together by the existing recorder. */
export const desktopDiagnosticRecordDataSchema = z
	.object({
		event: desktopDiagnosticEventSchema,
		state: desktopDiagnosticStateSchema,
	})
	.strict();

export const desktopDiagnosticForwardRecordSchema = desktopDiagnosticRecordDataSchema
	.extend({
		sequence: z.number().int().positive().safe(),
		observedAt: z.number().int().nonnegative().safe(),
	})
	.strict();

/** One bounded IPC batch; credentials, content, process arguments, and environment values have no fields. */
export const desktopDiagnosticsPayloadSchema = z
	.object({
		desktopInstanceId: z.string().uuid(),
		records: z.array(desktopDiagnosticForwardRecordSchema).min(1).max(100),
	})
	.strict();
export type DesktopDiagnosticsPayload = z.infer<typeof desktopDiagnosticsPayloadSchema>;
