import { z } from "zod";
import { runtimeTaskWorktreeInfoRequestSchema, runtimeWorkdirFileStatusSchema } from "./shared.js";

export const runtimeGitRepositoryInfoSchema = z.object({
	currentBranch: z.string().nullable(),
	defaultBranch: z.string().nullable(),
	branches: z.array(z.string()),
});
export type RuntimeGitRepositoryInfo = z.infer<typeof runtimeGitRepositoryInfoSchema>;

export const runtimeGitSyncActionSchema = z.enum(["fetch", "pull", "push"]);
export type RuntimeGitSyncAction = z.infer<typeof runtimeGitSyncActionSchema>;

export const runtimeGitSyncSummarySchema = z.object({
	currentBranch: z.string().nullable(),
	upstreamBranch: z.string().nullable(),
	changedFiles: z.number(),
	additions: z.number(),
	deletions: z.number(),
	aheadCount: z.number(),
	behindCount: z.number(),
});
export type RuntimeGitSyncSummary = z.infer<typeof runtimeGitSyncSummarySchema>;

export const runtimeGitSummaryResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	error: z.string().optional(),
});
export type RuntimeGitSummaryResponse = z.infer<typeof runtimeGitSummaryResponseSchema>;

export const runtimeGitSyncResponseSchema = z.object({
	ok: z.boolean(),
	action: runtimeGitSyncActionSchema,
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
	dirtyTree: z.boolean().optional(),
});
export type RuntimeGitSyncResponse = z.infer<typeof runtimeGitSyncResponseSchema>;

export const runtimeGitCheckoutRequestSchema = z.object({
	branch: z.string(),
	taskId: z.string().optional(),
	baseRef: z.string().optional(),
});
export type RuntimeGitCheckoutRequest = z.infer<typeof runtimeGitCheckoutRequestSchema>;

export const runtimeGitCheckoutResponseSchema = z.object({
	ok: z.boolean(),
	branch: z.string(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
	dirtyTree: z.boolean().optional(),
});
export type RuntimeGitCheckoutResponse = z.infer<typeof runtimeGitCheckoutResponseSchema>;

export const runtimeGitDiscardResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitDiscardResponse = z.infer<typeof runtimeGitDiscardResponseSchema>;

export const runtimeGitCreateBranchRequestSchema = z.object({
	branchName: z.string().min(1),
	startRef: z.string().min(1),
});
export type RuntimeGitCreateBranchRequest = z.infer<typeof runtimeGitCreateBranchRequestSchema>;

export const runtimeGitCreateBranchResponseSchema = z.object({
	ok: z.boolean(),
	branchName: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitCreateBranchResponse = z.infer<typeof runtimeGitCreateBranchResponseSchema>;

export const runtimeGitDeleteBranchRequestSchema = z.object({
	branchName: z.string().min(1),
});
export type RuntimeGitDeleteBranchRequest = z.infer<typeof runtimeGitDeleteBranchRequestSchema>;

export const runtimeGitDeleteBranchResponseSchema = z.object({
	ok: z.boolean(),
	branchName: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitDeleteBranchResponse = z.infer<typeof runtimeGitDeleteBranchResponseSchema>;

export const runtimeGitCommitRequestSchema = z.object({
	taskScope: runtimeTaskWorktreeInfoRequestSchema.nullable(),
	paths: z.array(z.string()).min(1),
	message: z.string().min(1),
	pushAfterCommit: z.boolean().optional(),
});
export type RuntimeGitCommitRequest = z.infer<typeof runtimeGitCommitRequestSchema>;

export const runtimeGitCommitResponseSchema = z.object({
	ok: z.boolean(),
	commitHash: z.string().optional(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
	pushOk: z.boolean().optional(),
	pushError: z.string().optional(),
});
export type RuntimeGitCommitResponse = z.infer<typeof runtimeGitCommitResponseSchema>;

export const runtimeGitDiscardFileRequestSchema = z.object({
	taskScope: runtimeTaskWorktreeInfoRequestSchema.nullable(),
	path: z.string().min(1),
	fileStatus: runtimeWorkdirFileStatusSchema,
});
export type RuntimeGitDiscardFileRequest = z.infer<typeof runtimeGitDiscardFileRequestSchema>;

export const runtimeGitRenameBranchRequestSchema = z.object({
	oldName: z.string().min(1),
	newName: z.string().min(1),
});
export type RuntimeGitRenameBranchRequest = z.infer<typeof runtimeGitRenameBranchRequestSchema>;

export const runtimeGitRenameBranchResponseSchema = z.object({
	ok: z.boolean(),
	oldName: z.string(),
	newName: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitRenameBranchResponse = z.infer<typeof runtimeGitRenameBranchResponseSchema>;

export const runtimeGitResetToRefRequestSchema = z.object({
	ref: z.string().min(1),
	taskId: z.string().optional(),
	baseRef: z.string().optional(),
});
export type RuntimeGitResetToRefRequest = z.infer<typeof runtimeGitResetToRefRequestSchema>;

export const runtimeGitResetToRefResponseSchema = z.object({
	ok: z.boolean(),
	ref: z.string(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitResetToRefResponse = z.infer<typeof runtimeGitResetToRefResponseSchema>;
