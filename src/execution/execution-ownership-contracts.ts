import { z } from "zod";

export const executionProviderSchema = z.enum(["codex", "claude"]);
export type ExecutionProvider = z.infer<typeof executionProviderSchema>;

export const executionOwnerModeSchema = z.enum(["native_tui", "structured"]);
export type ExecutionOwnerMode = z.infer<typeof executionOwnerModeSchema>;

export const executionOwnerStateSchema = z.enum([
	"native_tui",
	"handoff_to_structured_pending",
	"structured",
	"handoff_to_native_pending",
]);
export type ExecutionOwnerState = z.infer<typeof executionOwnerStateSchema>;

export const executionHistoryModeSchema = z.enum(["legacy", "paginated"]);
export type ExecutionHistoryMode = z.infer<typeof executionHistoryModeSchema>;

export const executionProcessIdentitySchema = z.object({
	processKind: z.enum(["pty", "stdio_app_server", "stdio_agent_sdk"]),
	pid: z.number().int().positive(),
	sessionInstanceId: z.string().min(1),
	launchOperationId: z.string().min(1).nullable(),
});
export type ExecutionProcessIdentity = z.infer<typeof executionProcessIdentitySchema>;

export const executionActiveTurnSchema = z.object({
	turnId: z.string().min(1).nullable(),
	clientUserMessageId: z.string().min(1),
	startedAt: z.number().finite().nonnegative(),
});
export type ExecutionActiveTurn = z.infer<typeof executionActiveTurnSchema>;

export const executionPendingHandoffSchema = z.object({
	operationId: z.string().min(1).max(128),
	targetOwner: executionOwnerModeSchema,
	expectedOwnerGeneration: z.number().int().nonnegative(),
	phase: z.enum(["recorded", "stopping_owner", "starting_replacement", "verifying_replacement"]),
	startedAt: z.number().finite().nonnegative(),
});
export type ExecutionPendingHandoff = z.infer<typeof executionPendingHandoffSchema>;

export const executionFailureSchema = z.object({
	code: z.enum([
		"owner_crashed",
		"turn_outcome_unknown",
		"stop_failed",
		"identity_mismatch",
		"profile_mismatch",
		"configuration_mismatch",
		"unsupported_version",
		"unsupported_history_mode",
		"history_unavailable",
		"worktree_missing",
	]),
	at: z.number().finite().nonnegative(),
});
export type ExecutionFailure = z.infer<typeof executionFailureSchema>;

export const taskExecutionOwnershipSchema = z.object({
	projectId: z.string().min(1),
	taskId: z.string().min(1),
	provider: executionProviderSchema,
	providerSessionId: z.string().min(1),
	providerSessionTreeId: z.string().min(1).nullable(),
	providerProfileFingerprint: z.string().length(64),
	configurationFingerprint: z.string().length(64).nullable(),
	providerVersion: z.string().min(1),
	protocolSchemaFingerprint: z.string().length(64),
	historyMode: executionHistoryModeSchema.nullable(),
	state: executionOwnerStateSchema,
	ownerGeneration: z.number().int().nonnegative(),
	ownerSessionInstanceId: z.string().min(1),
	ownerProcess: executionProcessIdentitySchema.nullable(),
	activeTurn: executionActiveTurnSchema.nullable(),
	pendingHandoff: executionPendingHandoffSchema.nullable(),
	lastFailure: executionFailureSchema.nullable(),
	updatedAt: z.number().finite().nonnegative(),
});
export type TaskExecutionOwnership = z.infer<typeof taskExecutionOwnershipSchema>;

export const executionHandoffOutcomeSchema = z.enum([
	"completed",
	"already_applied",
	"busy",
	"mid_turn_rejected",
	"native_owner_not_running",
	"exact_session_required",
	"provider_not_supported",
	"profile_mismatch",
	"configuration_mismatch",
	"unsupported_provider_version",
	"unsupported_history_mode",
	"history_unavailable",
	"worktree_missing",
	"stop_timed_out",
	"stop_failed",
	"replacement_start_failed",
	"identity_mismatch",
	"turn_outcome_unknown",
	"operation_identity_conflict",
	"stale_owner_generation",
	"internal_error",
]);
export type ExecutionHandoffOutcome = z.infer<typeof executionHandoffOutcomeSchema>;

export interface ExecutionHandoffResult {
	ok: boolean;
	outcome: ExecutionHandoffOutcome;
	ownership: TaskExecutionOwnership | null;
	replayed: boolean;
}

export const taskInteractionKindSchema = z.enum(["send_message", "answer_prompt", "stop_task"]);
export type TaskInteractionKind = z.infer<typeof taskInteractionKindSchema>;

export const MAX_TASK_INTERACTION_ID_LENGTH = 512;

export const taskInteractionOutcomeSchema = z.enum([
	"completed",
	"already_applied",
	"busy",
	"owner_not_structured",
	"turn_in_progress",
	"question_not_found",
	"approval_not_found",
	"unsupported_interaction",
	"interrupted",
	"operation_identity_conflict",
	"turn_outcome_unknown",
	"invalid_request",
	"failed",
]);
export type TaskInteractionOutcome = z.infer<typeof taskInteractionOutcomeSchema>;

export interface TaskInteractionResult {
	ok: boolean;
	outcome: TaskInteractionOutcome;
	replayed: boolean;
	turnId?: string;
}
