import { z } from "zod";
import { runtimeGitSyncSummarySchema } from "./git-sync.js";
import { runtimeTaskWorkspaceInfoRequestSchema } from "./shared.js";

export const runtimeGitMergeRequestSchema = z.object({
	branch: z.string(),
	taskId: z.string().optional(),
	baseRef: z.string().optional(),
});
export type RuntimeGitMergeRequest = z.infer<typeof runtimeGitMergeRequestSchema>;

// Conflict file info returned by content fetch
export const runtimeConflictFileSchema = z.object({
	path: z.string(),
	oursContent: z.string(),
	theirsContent: z.string(),
});
export type RuntimeConflictFile = z.infer<typeof runtimeConflictFileSchema>;

// Active conflict state — part of metadata
export const runtimeConflictStateSchema = z.object({
	operation: z.enum(["merge", "rebase"]),
	sourceBranch: z.string().nullable(),
	currentStep: z.number().int().nullable(),
	totalSteps: z.number().int().nullable(),
	conflictedFiles: z.array(z.string()),
	autoMergedFiles: z.array(z.string()).default([]),
});
export type RuntimeConflictState = z.infer<typeof runtimeConflictStateSchema>;

// Auto-merged file content (non-conflicting changes git merged automatically)
export const runtimeAutoMergedFileSchema = z.object({
	path: z.string(),
	oldContent: z.string(),
	newContent: z.string(),
});
export type RuntimeAutoMergedFile = z.infer<typeof runtimeAutoMergedFileSchema>;

// Request/response for fetching auto-merged file content
export const runtimeAutoMergedFilesRequestSchema = z.object({
	taskId: z.string().optional(),
	paths: z.array(z.string()),
});
export type RuntimeAutoMergedFilesRequest = z.infer<typeof runtimeAutoMergedFilesRequestSchema>;

export const runtimeAutoMergedFilesResponseSchema = z.object({
	ok: z.boolean(),
	files: z.array(runtimeAutoMergedFileSchema),
	error: z.string().optional(),
});
export type RuntimeAutoMergedFilesResponse = z.infer<typeof runtimeAutoMergedFilesResponseSchema>;

export const runtimeGitMergeResponseSchema = z.object({
	ok: z.boolean(),
	branch: z.string(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	conflictState: runtimeConflictStateSchema.optional(),
	error: z.string().optional(),
});
export type RuntimeGitMergeResponse = z.infer<typeof runtimeGitMergeResponseSchema>;

// Conflict resolution request
export const runtimeConflictResolveRequestSchema = z.object({
	taskId: z.string().optional(),
	path: z.string(),
	resolution: z.enum(["ours", "theirs"]),
});
export type RuntimeConflictResolveRequest = z.infer<typeof runtimeConflictResolveRequestSchema>;

// Continue merge/rebase request
export const runtimeConflictContinueRequestSchema = z.object({
	taskId: z.string().optional(),
});
export type RuntimeConflictContinueRequest = z.infer<typeof runtimeConflictContinueRequestSchema>;

// Continue response
export const runtimeConflictContinueResponseSchema = z.object({
	ok: z.boolean(),
	completed: z.boolean(),
	conflictState: runtimeConflictStateSchema.optional(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeConflictContinueResponse = z.infer<typeof runtimeConflictContinueResponseSchema>;

// Abort request
export const runtimeConflictAbortRequestSchema = z.object({
	taskId: z.string().optional(),
});
export type RuntimeConflictAbortRequest = z.infer<typeof runtimeConflictAbortRequestSchema>;

// Abort response
export const runtimeConflictAbortResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	error: z.string().optional(),
});
export type RuntimeConflictAbortResponse = z.infer<typeof runtimeConflictAbortResponseSchema>;

// Get conflict files with content
export const runtimeConflictFilesRequestSchema = z.object({
	taskId: z.string().optional(),
	paths: z.array(z.string()),
});
export type RuntimeConflictFilesRequest = z.infer<typeof runtimeConflictFilesRequestSchema>;

export const runtimeConflictFilesResponseSchema = z.object({
	ok: z.boolean(),
	files: z.array(runtimeConflictFileSchema),
	error: z.string().optional(),
});
export type RuntimeConflictFilesResponse = z.infer<typeof runtimeConflictFilesResponseSchema>;

// Stash entry — returned by stashList
export const runtimeStashEntrySchema = z.object({
	index: z.number().int().nonnegative(),
	message: z.string(),
	branch: z.string(),
	date: z.string(),
});
export type RuntimeStashEntry = z.infer<typeof runtimeStashEntrySchema>;

// Stash push response
export const runtimeStashPushResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeStashPushResponse = z.infer<typeof runtimeStashPushResponseSchema>;

// Stash pop/apply response
export const runtimeStashPopApplyResponseSchema = z.object({
	ok: z.boolean(),
	conflicted: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeStashPopApplyResponse = z.infer<typeof runtimeStashPopApplyResponseSchema>;

// Stash drop response
export const runtimeStashDropResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeStashDropResponse = z.infer<typeof runtimeStashDropResponseSchema>;

// Stash show response
export const runtimeStashShowResponseSchema = z.object({
	ok: z.boolean(),
	diff: z.string().optional(),
	error: z.string().optional(),
});
export type RuntimeStashShowResponse = z.infer<typeof runtimeStashShowResponseSchema>;

// Stash list response
export const runtimeStashListResponseSchema = z.object({
	ok: z.boolean(),
	entries: z.array(runtimeStashEntrySchema),
	error: z.string().optional(),
});
export type RuntimeStashListResponse = z.infer<typeof runtimeStashListResponseSchema>;

// Stash push request
export const runtimeStashPushRequestSchema = z.object({
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable(),
	paths: z.array(z.string()),
	message: z.string().optional(),
});

// Stash action request (pop/apply/drop)
export const runtimeStashActionRequestSchema = z.object({
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable(),
	index: z.number().int().nonnegative(),
});
