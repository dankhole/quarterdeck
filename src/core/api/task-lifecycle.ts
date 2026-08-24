import { z } from "zod";

import { runtimeProjectStateResponseSchema } from "./project-state.js";
import { runtimeAgentIdSchema, runtimeBoardColumnIdSchema, runtimeTaskImageSchema } from "./shared.js";
import { runtimeTaskSessionSummarySchema } from "./task-session.js";

const operationIdSchema = z.string().trim().min(1).max(128);
const taskIdSchema = z.string().trim().min(1);
const taskCreatedAtSchema = z.number().finite().nonnegative();
const expectedRevisionSchema = z.number().int().nonnegative();
const geometrySchema = {
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
};

const taskIdentitySchema = {
	operationId: operationIdSchema,
	taskId: taskIdSchema,
	taskCreatedAt: taskCreatedAtSchema,
};

export const runtimeTaskLifecycleCommandSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("start"),
		...taskIdentitySchema,
		expectedRevision: expectedRevisionSchema,
		...geometrySchema,
	}),
	z.object({
		kind: z.literal("trash"),
		...taskIdentitySchema,
		expectedRevision: expectedRevisionSchema,
		sourceColumnId: runtimeBoardColumnIdSchema.exclude(["trash"]),
	}),
	z.object({
		kind: z.literal("restore"),
		...taskIdentitySchema,
		expectedRevision: expectedRevisionSchema,
		...geometrySchema,
	}),
	z.object({
		kind: z.literal("stop"),
		...taskIdentitySchema,
		expectedRevision: expectedRevisionSchema,
		sessionInstanceId: z.string().trim().min(1).nullable().optional(),
	}),
	z.object({
		kind: z.literal("restart"),
		...taskIdentitySchema,
		expectedRevision: expectedRevisionSchema,
		sessionInstanceId: z.string().trim().min(1).nullable().optional(),
		...geometrySchema,
	}),
	z.object({
		kind: z.literal("delete"),
		...taskIdentitySchema,
		expectedRevision: expectedRevisionSchema,
		sessionInstanceId: z.string().trim().min(1).nullable().optional(),
	}),
	z.object({
		kind: z.literal("create_and_start"),
		operationId: operationIdSchema,
		expectedRevision: expectedRevisionSchema,
		startedAt: z.number().finite().nonnegative(),
		task: z.object({
			taskId: taskIdSchema,
			title: z.string().nullable().optional(),
			prompt: z.string(),
			images: z.array(runtimeTaskImageSchema).optional(),
			baseRef: z.string(),
			agentId: runtimeAgentIdSchema.exclude(["pi"]).optional(),
			useWorktree: z.boolean().optional(),
			branch: z.string().optional(),
			pinned: z.boolean().optional(),
			createdAt: taskCreatedAtSchema,
		}),
		...geometrySchema,
	}),
]);
export type RuntimeTaskLifecycleCommand = z.infer<typeof runtimeTaskLifecycleCommandSchema>;

export const runtimeTaskLifecycleOperationKindSchema = z.enum([
	"create_and_start",
	"start",
	"trash",
	"restore",
	"stop",
	"restart",
	"delete",
]);
export type RuntimeTaskLifecycleOperationKind = z.infer<typeof runtimeTaskLifecycleOperationKindSchema>;

export const runtimeTaskLifecycleOperationStatusSchema = z.enum([
	"pending",
	"completed",
	"completed_with_warning",
	"failed",
	"superseded",
]);
export type RuntimeTaskLifecycleOperationStatus = z.infer<typeof runtimeTaskLifecycleOperationStatusSchema>;

export const runtimeTaskLifecycleOperationPhaseSchema = z.enum([
	"requested",
	"board_transition",
	"stopping_session",
	"archiving_worktree",
	"ensuring_worktree",
	"starting_session",
	"purging_workspace",
	"deleting_card",
	"compensating",
	"finished",
]);
export type RuntimeTaskLifecycleOperationPhase = z.infer<typeof runtimeTaskLifecycleOperationPhaseSchema>;

export const runtimeTaskLifecycleOutcomeCodeSchema = z.enum([
	"completed",
	"completed_with_warning",
	"already_applied",
	"busy",
	"identity_conflict",
	"stale_task",
	"invalid_transition",
	"revision_conflict",
	"stop_timed_out",
	"stop_failed",
	"worktree_failed",
	"session_start_failed",
	"compensation_failed",
	"superseded",
	"internal_error",
]);
export type RuntimeTaskLifecycleOutcomeCode = z.infer<typeof runtimeTaskLifecycleOutcomeCodeSchema>;

export const runtimeTaskLifecycleOperationSchema = z.object({
	operationId: operationIdSchema,
	projectId: z.string(),
	taskId: taskIdSchema,
	taskCreatedAt: taskCreatedAtSchema,
	kind: runtimeTaskLifecycleOperationKindSchema,
	status: runtimeTaskLifecycleOperationStatusSchema,
	phase: runtimeTaskLifecycleOperationPhaseSchema,
	sourceColumnId: runtimeBoardColumnIdSchema.nullable(),
	targetColumnId: runtimeBoardColumnIdSchema.nullable(),
	acceptedBoardRevision: z.number().int().nonnegative().nullable(),
	launchOperationId: z.string().nullable(),
	childOperationIds: z.array(z.string()),
	outcomeCode: runtimeTaskLifecycleOutcomeCodeSchema.nullable(),
	requestedAt: z.number().finite().nonnegative(),
	updatedAt: z.number().finite().nonnegative(),
	completedAt: z.number().finite().nonnegative().nullable(),
});
export type RuntimeTaskLifecycleOperation = z.infer<typeof runtimeTaskLifecycleOperationSchema>;

export const runtimeTaskLifecycleResultSchema = z.object({
	ok: z.boolean(),
	operation: runtimeTaskLifecycleOperationSchema,
	state: runtimeProjectStateResponseSchema,
	summary: runtimeTaskSessionSummarySchema.nullable(),
	warning: z.string().optional(),
	error: z.string().optional(),
});
export type RuntimeTaskLifecycleResult = z.infer<typeof runtimeTaskLifecycleResultSchema>;

export const runtimeTaskLifecycleGetRequestSchema = z.object({
	operationId: operationIdSchema,
});
