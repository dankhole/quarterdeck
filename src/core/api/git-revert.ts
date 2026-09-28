import { z } from "zod";
import { runtimeConflictStateSchema } from "./git-merge.js";
import { runtimeTaskWorktreeInfoRequestSchema } from "./shared.js";

export const runtimeGitRevertRequestSchema = z.object({
	commitHash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
	expectedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
	expectedBranch: z.string().min(1),
	taskScope: runtimeTaskWorktreeInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitRevertRequest = z.infer<typeof runtimeGitRevertRequestSchema>;

export const runtimeGitRevertResponseSchema = z.object({
	ok: z.boolean(),
	commitHash: z.string(),
	output: z.string(),
	conflictState: runtimeConflictStateSchema.optional(),
	error: z.string().optional(),
});
export type RuntimeGitRevertResponse = z.infer<typeof runtimeGitRevertResponseSchema>;
