import { z } from "zod";
import { runtimeHostIntegrationActionResponseSchema, runtimeOpenTargetIdSchema } from "./host-integrations.js";

export const runtimeWorkdirFileStatusSchema = z.enum([
	"modified",
	"added",
	"deleted",
	"renamed",
	"copied",
	"untracked",
	"conflicted",
	"unknown",
]);
export type RuntimeWorkdirFileStatus = z.infer<typeof runtimeWorkdirFileStatusSchema>;

export const runtimeAgentIdSchema = z.enum(["claude", "codex", "pi"]);
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>;

// Pi remains in RuntimeAgentId so persisted experimental sessions keep loading,
// but new cross-agent architecture targets only maintained integrations.
export const runtimeMaintainedAgentIdSchema = z.enum(["claude", "codex"]);
export type RuntimeMaintainedAgentId = z.infer<typeof runtimeMaintainedAgentIdSchema>;

export const runtimeBoardColumnIdSchema = z.enum(["backlog", "in_progress", "review", "trash"]);
export type RuntimeBoardColumnId = z.infer<typeof runtimeBoardColumnIdSchema>;

export const runtimeTaskImageSchema = z.object({
	id: z.string(),
	data: z.string(),
	mimeType: z.string(),
	name: z.string().optional(),
});
export type RuntimeTaskImage = z.infer<typeof runtimeTaskImageSchema>;

export const runtimeSlashCommandSchema = z.object({
	name: z.string(),
	instructions: z.string(),
	description: z.string().optional(),
});
export type RuntimeSlashCommand = z.infer<typeof runtimeSlashCommandSchema>;

export const runtimeSlashCommandsResponseSchema = z.object({
	commands: z.array(runtimeSlashCommandSchema),
});
export type RuntimeSlashCommandsResponse = z.infer<typeof runtimeSlashCommandsResponseSchema>;

/** Project-level terminal command shortcuts (top bar). For agent prompt shortcuts, see promptShortcutSchema. */
export const runtimeProjectShortcutSchema = z.object({
	label: z.string(),
	command: z.string(),
	icon: z.string().optional(),
});
export type RuntimeProjectShortcut = z.infer<typeof runtimeProjectShortcutSchema>;

/** Global agent prompt injection shortcuts (sidebar review cards). For project terminal commands, see runtimeProjectShortcutSchema. */
export const promptShortcutSchema = z.object({
	label: z.string().min(1).max(30),
	prompt: z.string().min(1),
});
export type PromptShortcut = z.infer<typeof promptShortcutSchema>;

export const runtimeOpenFileRequestSchema = z.object({
	filePath: z.string(),
});
export type RuntimeOpenFileRequest = z.infer<typeof runtimeOpenFileRequestSchema>;

export const runtimeOpenFileResponseSchema = runtimeHostIntegrationActionResponseSchema;
export type RuntimeOpenFileResponse = z.infer<typeof runtimeOpenFileResponseSchema>;

export const runtimeOpenProjectRequestSchema = z
	.object({
		targetId: runtimeOpenTargetIdSchema,
	})
	.strict();
export type RuntimeOpenProjectRequest = z.infer<typeof runtimeOpenProjectRequestSchema>;

export const runtimeOpenProjectResponseSchema = runtimeHostIntegrationActionResponseSchema;
export type RuntimeOpenProjectResponse = z.infer<typeof runtimeOpenProjectResponseSchema>;

export const runtimeTaskWorktreeInfoRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeTaskWorktreeInfoRequest = z.infer<typeof runtimeTaskWorktreeInfoRequestSchema>;
