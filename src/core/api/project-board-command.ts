import { z } from "zod";
import { runtimeProjectStateResponseSchema } from "./project-state.js";
import {
	runtimeAgentIdSchema,
	runtimeBoardColumnIdSchema,
	runtimeMaintainedAgentIdSchema,
	runtimeTaskImageSchema,
} from "./shared.js";

const commandTaskIdSchema = z.string().trim().min(1);
const commandTimestampSchema = z.number().finite().nonnegative();

export const runtimeProjectBoardCommandSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("create_task"),
		columnId: runtimeBoardColumnIdSchema,
		taskId: commandTaskIdSchema,
		title: z.string().nullable().optional(),
		prompt: z.string(),
		images: z.array(runtimeTaskImageSchema).optional(),
		baseRef: z.string(),
		agentId: runtimeMaintainedAgentIdSchema.optional(),
		useWorktree: z.boolean().optional(),
		branch: z.string().optional(),
		pinned: z.boolean().optional(),
		createdAt: commandTimestampSchema,
	}),
	z.object({
		kind: z.literal("update_task"),
		taskId: commandTaskIdSchema,
		title: z.string().nullable().optional(),
		prompt: z.string(),
		images: z.array(runtimeTaskImageSchema).optional(),
		baseRef: z.string(),
		useWorktree: z.boolean().optional(),
		pinned: z.boolean().optional(),
		updatedAt: commandTimestampSchema,
	}),
	z.object({
		kind: z.literal("move_task"),
		taskId: commandTaskIdSchema,
		sourceColumnId: runtimeBoardColumnIdSchema.optional(),
		targetColumnId: runtimeBoardColumnIdSchema,
		targetIndex: z.number().int().nonnegative().optional(),
		updatedAt: commandTimestampSchema,
	}),
	z.object({
		kind: z.literal("reorder_task"),
		taskId: commandTaskIdSchema,
		columnId: runtimeBoardColumnIdSchema,
		targetIndex: z.number().int().nonnegative(),
	}),
	z.object({
		kind: z.literal("reorder_column"),
		columnId: runtimeBoardColumnIdSchema,
		taskIds: z.array(commandTaskIdSchema).min(1).max(10_000),
	}),
	z.object({
		kind: z.literal("patch_task"),
		taskId: commandTaskIdSchema,
		expectedTitle: z.string().nullable().optional(),
		title: z.string().nullable().optional(),
		agentId: runtimeAgentIdSchema.nullable().optional(),
		baseRef: z.string().optional(),
		baseRefPinned: z.boolean().nullable().optional(),
		useWorktree: z.boolean().nullable().optional(),
		workingDirectory: z.string().min(1).nullable().optional(),
		branch: z.string().min(1).nullable().optional(),
		pinned: z.boolean().nullable().optional(),
		updatedAt: commandTimestampSchema,
	}),
	z.object({
		kind: z.literal("add_dependency"),
		firstTaskId: commandTaskIdSchema,
		secondTaskId: commandTaskIdSchema,
		dependencyId: z.string().trim().min(1),
		createdAt: commandTimestampSchema,
	}),
	z.object({
		kind: z.literal("remove_dependency"),
		dependencyId: z.string().trim().min(1),
	}),
	z.object({
		kind: z.literal("delete_tasks"),
		taskIds: z.array(commandTaskIdSchema).min(1),
	}),
]);

export type RuntimeProjectBoardCommand = z.infer<typeof runtimeProjectBoardCommandSchema>;

/**
 * Board commands whose durable consequences include task-session or workspace
 * lifecycle effects. Browser clients may project these transitions
 * optimistically, but only ProjectTaskLifecycleService may persist them.
 */
export function isLifecycleManagedBoardCommand(command: RuntimeProjectBoardCommand): boolean {
	if (command.kind === "delete_tasks") {
		return true;
	}
	if (command.kind === "create_task") {
		return command.columnId === "in_progress";
	}
	if (command.kind !== "move_task") {
		return false;
	}
	return (
		command.targetColumnId === "trash" ||
		(command.sourceColumnId === "backlog" && command.targetColumnId === "in_progress") ||
		(command.sourceColumnId === "trash" && command.targetColumnId === "review")
	);
}

export const runtimeProjectBoardCommandEnvelopeSchema = z.object({
	commandId: z.string().trim().min(1).max(128),
	expectedRevision: z.number().int().nonnegative(),
	command: runtimeProjectBoardCommandSchema,
});

export type RuntimeProjectBoardCommandEnvelope = z.infer<typeof runtimeProjectBoardCommandEnvelopeSchema>;

export const runtimeProjectBoardCommandBatchEnvelopeSchema = z.object({
	commandId: z.string().trim().min(1).max(128),
	expectedRevision: z.number().int().nonnegative(),
	commands: z.array(runtimeProjectBoardCommandSchema).min(1).max(512),
});

export type RuntimeProjectBoardCommandBatchEnvelope = z.infer<typeof runtimeProjectBoardCommandBatchEnvelopeSchema>;

export const runtimeProjectBoardCommandExecutionResultSchema = z.object({
	state: runtimeProjectStateResponseSchema,
	changed: z.boolean(),
	acceptedChange: z.boolean(),
	replayed: z.boolean(),
});

export type RuntimeProjectBoardCommandExecutionResult = z.infer<typeof runtimeProjectBoardCommandExecutionResultSchema>;
