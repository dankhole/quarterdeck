import { z } from "zod";
import { runtimeAgentIdSchema, runtimeTaskImageSchema } from "./shared.js";

export const RUNTIME_DETAIL_TERMINAL_TASK_PREFIX = "__detail_terminal__:";

export function getRuntimeDetailTerminalTaskId(taskId: string): string {
	return `${RUNTIME_DETAIL_TERMINAL_TASK_PREFIX}${taskId}`;
}

export const runtimeTaskSessionStateSchema = z.enum(["idle", "running", "awaiting_review"]);
export type RuntimeTaskSessionState = z.infer<typeof runtimeTaskSessionStateSchema>;

// Input-only compatibility for session records written before failures and
// interruptions became Review detail. Canonical runtime output cannot author
// either value.
const persistedRuntimeTaskSessionStateSchema = z.union([
	runtimeTaskSessionStateSchema,
	z.enum(["failed", "interrupted"]),
]);

export const runtimeTaskSessionReviewReasonSchema = z
	.enum(["attention", "exit", "error", "interrupted", "hook", "stalled", "unconfirmed"])
	.nullable();
export type RuntimeTaskSessionReviewReason = z.infer<typeof runtimeTaskSessionReviewReasonSchema>;

export const runtimeTaskHookActivitySchema = z.object({
	activityText: z.string().nullable().default(null),
	toolName: z.string().nullable().default(null),
	toolInputSummary: z.string().nullable().default(null),
	finalMessage: z.string().nullable().default(null),
	hookEventName: z.string().nullable().default(null),
	notificationType: z.string().nullable().default(null),
	source: z.string().nullable().default(null),
	conversationSummaryText: z.string().nullable().default(null),
});
export type RuntimeTaskHookActivity = z.infer<typeof runtimeTaskHookActivitySchema>;

export const runtimeTaskInteractionProviderSchema = z.enum(["codex", "claude", "pi"]);
export type RuntimeTaskInteractionProvider = z.infer<typeof runtimeTaskInteractionProviderSchema>;

export const runtimeTaskInteractionKindSchema = z.enum(["permission", "question", "plan_approval", "elicitation"]);
export type RuntimeTaskInteractionKind = z.infer<typeof runtimeTaskInteractionKindSchema>;

export const runtimeTaskInteractionStatusSchema = z.enum(["waiting", "response_submitted", "resolution_unknown"]);
export type RuntimeTaskInteractionStatus = z.infer<typeof runtimeTaskInteractionStatusSchema>;

export const runtimeTaskInteractionResponseKindSchema = z.enum(["submit", "cancel", "provider_denied"]);
export type RuntimeTaskInteractionResponseKind = z.infer<typeof runtimeTaskInteractionResponseKindSchema>;

/**
 * Positive launch-scoped evidence for the public Running claim made by a
 * native Codex, Claude, or Pi task session. A live PTY, terminal bytes, and browser
 * input are deliberately absent: only the current provider hook path can
 * author this record.
 */
export const runtimeTaskNativeWorkEvidenceSchema = z.object({
	provider: runtimeTaskInteractionProviderSchema,
	sessionInstanceId: z.string().min(1),
	providerSessionId: z.string().nullable(),
	turnId: z.string().nullable(),
	hookEventName: z.string().min(1),
	confirmedAt: z.number().int().nonnegative(),
	expiresAt: z.number().int().nonnegative(),
});
export type RuntimeTaskNativeWorkEvidence = z.infer<typeof runtimeTaskNativeWorkEvidenceSchema>;

/**
 * Durable identity and lifecycle for the one provider interaction currently
 * blocking (or recently blocking) a task. The top-level session state remains
 * the execution/review lifecycle; this nested record distinguishes an active
 * wait from a response whose delivery succeeded but whose provider-side
 * resumption has not yet been confirmed.
 */
export const runtimeTaskOutstandingInteractionSchema = z.object({
	provider: runtimeTaskInteractionProviderSchema,
	kind: runtimeTaskInteractionKindSchema,
	status: runtimeTaskInteractionStatusSchema,
	requestEventName: z.string(),
	openedAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	responseSubmittedAt: z.number().int().nonnegative().nullable(),
	responseKind: runtimeTaskInteractionResponseKindSchema.nullable(),
	sessionInstanceId: z.string().nullable(),
	providerSessionId: z.string().nullable(),
	turnId: z.string().nullable(),
	promptId: z.string().nullable(),
	toolUseId: z.string().nullable(),
	elicitationId: z.string().nullable(),
	providerAgentId: z.string().nullable(),
	toolName: z.string().nullable(),
});
export type RuntimeTaskOutstandingInteraction = z.infer<typeof runtimeTaskOutstandingInteractionSchema>;

export const runtimeHookMetadataSchema = runtimeTaskHookActivitySchema
	.extend({
		sessionId: z.string().nullable().default(null),
		sessionInstanceId: z.string().nullable().default(null),
		turnId: z.string().nullable().default(null),
		promptId: z.string().nullable().default(null),
		toolUseId: z.string().nullable().default(null),
		elicitationId: z.string().nullable().default(null),
		providerAgentId: z.string().nullable().default(null),
		transcriptPath: z.string().nullable().default(null),
	})
	.partial();
export type RuntimeHookMetadata = z.infer<typeof runtimeHookMetadataSchema>;

export const runtimeHookDeliverySchema = z.object({
	id: z.string().uuid(),
	occurredAt: z.number().int().nonnegative(),
});
export type RuntimeHookDelivery = z.infer<typeof runtimeHookDeliverySchema>;

export const runtimeHookEventSchema = z.enum(["to_review", "to_in_progress", "activity"]);
export type RuntimeHookEvent = z.infer<typeof runtimeHookEventSchema>;

/**
 * Content-free provider identity retained only to rebuild the native-hook
 * ordering guard after a runtime restart. This is not task meaning and must
 * never be interpreted by cards, notifications, or other consumers.
 */
export const runtimeTaskProviderHookOrderObservationSchema = z.object({
	event: runtimeHookEventSchema,
	deliveryId: z.string().uuid(),
	occurredAt: z.number().int().nonnegative(),
	source: z.enum(["codex", "claude", "pi"]),
	sessionInstanceId: z.string().min(1),
	hookEventName: z.string().nullable(),
	notificationType: z.string().nullable(),
	turnId: z.string().nullable(),
	promptId: z.string().nullable(),
	toolUseId: z.string().nullable(),
	elicitationId: z.string().nullable(),
	toolName: z.string().nullable(),
});
export type RuntimeTaskProviderHookOrderObservation = z.infer<typeof runtimeTaskProviderHookOrderObservationSchema>;

export const conversationSummaryEntrySchema = z.object({
	/** The extracted assistant message text, capped at 500 chars. */
	text: z.string(),
	/** Timestamp when this summary was captured. */
	capturedAt: z.number(),
	/** Which session stop event produced this (first, latest, etc.). */
	sessionIndex: z.number().int().nonnegative(),
});
export type ConversationSummaryEntry = z.infer<typeof conversationSummaryEntrySchema>;

export const runtimeTaskTurnCheckpointSchema = z.object({
	turn: z.number().int().positive(),
	ref: z.string(),
	commit: z.string(),
	createdAt: z.number(),
});
export type RuntimeTaskTurnCheckpoint = z.infer<typeof runtimeTaskTurnCheckpointSchema>;

const runtimeTaskSessionSummaryBaseSchema = z.object({
	taskId: z.string(),
	/** Stable identity for the exact PTY process represented by this summary. */
	sessionInstanceId: z.string().nullable().optional(),
	/** Stable lifecycle operation that launched this session, when applicable. */
	launchOperationId: z.string().nullable().optional(),
	state: persistedRuntimeTaskSessionStateSchema,
	agentId: runtimeAgentIdSchema.nullable(),
	sessionLaunchPath: z.string().nullable().default(null),
	resumeSessionId: z.string().nullable().optional(),
	pid: z.number().nullable(),
	startedAt: z.number().nullable(),
	updatedAt: z.number(),
	lastOutputAt: z.number().nullable(),
	reviewReason: runtimeTaskSessionReviewReasonSchema,
	exitCode: z.number().nullable(),
	lastHookAt: z.number().nullable().default(null),
	/** Provider-recorded occurrence time of the newest accepted launch-scoped hook. */
	lastProviderHookOccurredAt: z.number().int().nonnegative().nullable().default(null),
	/** Bounded durable deduplication window for reliable hook delivery retries. */
	recentProviderHookDeliveryIds: z.array(z.string().uuid()).max(128).default([]),
	/** Bounded content-free history used only to rebuild provider-specific ordering after restart. */
	recentProviderHookOrderObservations: z.array(runtimeTaskProviderHookOrderObservationSchema).max(512).default([]),
	latestHookActivity: runtimeTaskHookActivitySchema.nullable().default(null),
	/** Current provider interaction, if user input was requested or its resolution remains unconfirmed. */
	outstandingInteraction: runtimeTaskOutstandingInteractionSchema.nullable().default(null),
	/** Current bounded proof behind a native Codex/Claude/Pi Running projection. */
	nativeWorkEvidence: runtimeTaskNativeWorkEvidenceSchema.nullable().default(null),
	stalledSince: z.number().nullable().default(null),
	/** Durable handoff indicating that the next runtime must restore the task's interactive agent session. */
	startupRecoveryRequired: z.boolean().optional(),
	/** Legacy persistence erased the prior semantic state; remain neutral until a new event establishes meaning. */
	startupRecoverySemanticStateUncertain: z.boolean().optional(),
	warningMessage: z.string().nullable().optional(),
	latestTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	previousTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	conversationSummaries: z.array(conversationSummaryEntrySchema).default([]),
	displaySummary: z.string().nullable().default(null),
	displaySummaryGeneratedAt: z.number().nullable().default(null),
});

type ParsedRuntimeTaskSessionSummary = z.infer<typeof runtimeTaskSessionSummaryBaseSchema>;
type NormalizedRuntimeTaskSessionSummary = Omit<ParsedRuntimeTaskSessionSummary, "state"> & {
	state: RuntimeTaskSessionState;
};

export interface NormalizeRuntimeTaskSessionSummaryOptions {
	/** Hydrated native evidence belongs to a process owned by the previous runtime. */
	invalidateNativeWorkEvidence?: boolean;
	/** Store-owned clock used to expire an admitted Running lease. */
	now?: number;
}

/**
 * Normalize legacy and contradictory records into the conservative canonical
 * session contract. Compatibility input may still contain old top-level
 * `failed`/`interrupted` values, but normal runtime output represents both as
 * Review plus a reason. An interaction always outranks Running.
 */
export function normalizeRuntimeTaskSessionSummary(
	summary: ParsedRuntimeTaskSessionSummary,
	options: NormalizeRuntimeTaskSessionSummaryOptions = {},
): NormalizedRuntimeTaskSessionSummary {
	const migratedLegacyInterrupted =
		summary.state === "interrupted" && typeof summary.startupRecoveryRequired !== "boolean";
	let next: NormalizedRuntimeTaskSessionSummary = {
		...summary,
		state: summary.state === "failed" || summary.state === "interrupted" ? "awaiting_review" : summary.state,
		reviewReason:
			summary.state === "failed" ? "error" : summary.state === "interrupted" ? "interrupted" : summary.reviewReason,
		nativeWorkEvidence:
			summary.state === "failed" || summary.state === "interrupted" ? null : summary.nativeWorkEvidence,
		...(migratedLegacyInterrupted
			? { startupRecoveryRequired: true, startupRecoverySemanticStateUncertain: true }
			: {}),
	};

	const interaction = next.outstandingInteraction;
	if (interaction) {
		const reviewReason =
			interaction.status === "resolution_unknown"
				? "error"
				: interaction.kind === "permission"
					? "hook"
					: "attention";
		next = {
			...next,
			state: "awaiting_review",
			reviewReason,
			nativeWorkEvidence: null,
		};
	}

	const isSupportedNativeAgent = next.agentId === "codex" || next.agentId === "claude" || next.agentId === "pi";
	if (next.state === "running" && isSupportedNativeAgent) {
		const evidence = next.nativeWorkEvidence;
		const invalidEvidence =
			options.invalidateNativeWorkEvidence === true ||
			!evidence ||
			evidence.provider !== next.agentId ||
			!next.sessionInstanceId ||
			evidence.sessionInstanceId !== next.sessionInstanceId ||
			next.pid === null ||
			evidence.expiresAt < evidence.confirmedAt ||
			(options.now !== undefined && evidence.expiresAt <= options.now);
		if (invalidEvidence) {
			next = {
				...next,
				state: "awaiting_review",
				reviewReason: options.invalidateNativeWorkEvidence ? "interrupted" : "unconfirmed",
				nativeWorkEvidence: null,
				...(options.invalidateNativeWorkEvidence ? { pid: null, startupRecoveryRequired: true } : {}),
			};
		} else if (next.reviewReason !== null) {
			next = { ...next, reviewReason: null };
		}
	}

	if (next.state !== "running" && next.nativeWorkEvidence) {
		next = { ...next, nativeWorkEvidence: null };
	}
	if (next.state === "idle") {
		next = {
			...next,
			reviewReason: null,
			outstandingInteraction: null,
			nativeWorkEvidence: null,
		};
	}
	return next;
}

export const runtimeTaskSessionSummarySchema = runtimeTaskSessionSummaryBaseSchema.transform((summary) =>
	normalizeRuntimeTaskSessionSummary(summary),
);
export type RuntimeTaskSessionSummary = z.infer<typeof runtimeTaskSessionSummarySchema>;

export const runtimeTaskSessionStartRequestSchema = z.object({
	taskId: z.string(),
	launchOperationId: z.string().trim().min(1).max(128).optional(),
	prompt: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	agentId: runtimeAgentIdSchema.optional(),
	resumeConversation: z.boolean().optional(),
	awaitReview: z.boolean().optional(),
	baseRef: z.string(),
	useWorktree: z.boolean().optional(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
});
export type RuntimeTaskSessionStartRequest = z.infer<typeof runtimeTaskSessionStartRequestSchema>;

export const runtimeTaskSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStartResponse = z.infer<typeof runtimeTaskSessionStartResponseSchema>;

export const runtimeTaskSessionStopRequestSchema = z.object({
	taskId: z.string(),
	waitForExit: z.boolean().optional(),
	sessionInstanceId: z.string().trim().min(1).optional(),
});
export type RuntimeTaskSessionStopRequest = z.infer<typeof runtimeTaskSessionStopRequestSchema>;

export const runtimeTaskSessionStopOutcomeSchema = z.enum([
	"requested",
	"not_running",
	"exited",
	"timed_out",
	"failed",
]);
export type RuntimeTaskSessionStopOutcome = z.infer<typeof runtimeTaskSessionStopOutcomeSchema>;

export const runtimeTaskSessionStopResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	didExit: z.boolean().nullable(),
	outcome: runtimeTaskSessionStopOutcomeSchema,
	error: z.string().optional(),
});
export type RuntimeTaskSessionStopResponse = z.infer<typeof runtimeTaskSessionStopResponseSchema>;

export const runtimeTaskSessionInputRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	appendNewline: z.boolean().optional(),
	intent: z.enum(["write", "submit"]),
});
export type RuntimeTaskSessionInputRequest = z.infer<typeof runtimeTaskSessionInputRequestSchema>;

export const runtimeTaskSessionInputResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionInputResponse = z.infer<typeof runtimeTaskSessionInputResponseSchema>;

export const runtimeShellSessionStartRequestSchema = z.object({
	taskId: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	projectTaskId: z.string().optional(),
	baseRef: z.string(),
});
export type RuntimeShellSessionStartRequest = z.infer<typeof runtimeShellSessionStartRequestSchema>;

export const runtimeShellSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	shellBinary: z.string().nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeShellSessionStartResponse = z.infer<typeof runtimeShellSessionStartResponseSchema>;

export const runtimeHookIngestRequestSchema = z.object({
	taskId: z.string(),
	projectId: z.string(),
	event: runtimeHookEventSchema,
	metadata: runtimeHookMetadataSchema.optional(),
	delivery: runtimeHookDeliverySchema.optional(),
});
export type RuntimeHookIngestRequest = z.infer<typeof runtimeHookIngestRequestSchema>;

export const runtimeHookIngestResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeHookIngestResponse = z.infer<typeof runtimeHookIngestResponseSchema>;
