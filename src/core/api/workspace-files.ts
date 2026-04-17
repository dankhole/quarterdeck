import { z } from "zod";
import { runtimeWorkspaceFileStatusSchema } from "./shared.js";

export const runtimeWorkspaceFileChangeSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: runtimeWorkspaceFileStatusSchema,
	additions: z.number(),
	deletions: z.number(),
	oldText: z.string().nullable(),
	newText: z.string().nullable(),
});
export type RuntimeWorkspaceFileChange = z.infer<typeof runtimeWorkspaceFileChangeSchema>;

export const runtimeDiffModeSchema = z.enum(["two_dot", "three_dot"]);
export type RuntimeDiffMode = z.infer<typeof runtimeDiffModeSchema>;

export const runtimeWorkspaceChangesRequestSchema = z.object({
	taskId: z.string().nullable(),
	baseRef: z.string().optional(),
	mode: z.enum(["working_copy", "last_turn"]).optional(),
	fromRef: z.string().optional(),
	toRef: z.string().optional(),
	diffMode: runtimeDiffModeSchema.optional(),
});
export type RuntimeWorkspaceChangesRequest = z.infer<typeof runtimeWorkspaceChangesRequestSchema>;

export const runtimeWorkspaceChangesModeSchema = z.enum(["working_copy", "last_turn"]);
export type RuntimeWorkspaceChangesMode = z.infer<typeof runtimeWorkspaceChangesModeSchema>;

export const runtimeWorkspaceChangesResponseSchema = z.object({
	repoRoot: z.string(),
	generatedAt: z.number(),
	files: z.array(runtimeWorkspaceFileChangeSchema),
});
export type RuntimeWorkspaceChangesResponse = z.infer<typeof runtimeWorkspaceChangesResponseSchema>;

export const runtimeFileDiffRequestSchema = z.object({
	taskId: z.string().nullable(),
	baseRef: z.string().optional(),
	mode: runtimeWorkspaceChangesModeSchema.optional(),
	fromRef: z.string().optional(),
	toRef: z.string().optional(),
	diffMode: runtimeDiffModeSchema.optional(),
	path: z.string().min(1),
	previousPath: z.string().optional(),
	status: runtimeWorkspaceFileStatusSchema,
});
export type RuntimeFileDiffRequest = z.infer<typeof runtimeFileDiffRequestSchema>;

export const runtimeFileDiffResponseSchema = z.object({
	path: z.string(),
	oldText: z.string().nullable(),
	newText: z.string().nullable(),
});
export type RuntimeFileDiffResponse = z.infer<typeof runtimeFileDiffResponseSchema>;

export const runtimeWorkspaceFileSearchRequestSchema = z.object({
	query: z.string(),
	limit: z.number().int().positive().optional(),
});
export type RuntimeWorkspaceFileSearchRequest = z.infer<typeof runtimeWorkspaceFileSearchRequestSchema>;

export const runtimeWorkspaceFileSearchMatchSchema = z.object({
	path: z.string(),
	name: z.string(),
	changed: z.boolean(),
});
export type RuntimeWorkspaceFileSearchMatch = z.infer<typeof runtimeWorkspaceFileSearchMatchSchema>;

export const runtimeWorkspaceFileSearchResponseSchema = z.object({
	query: z.string(),
	files: z.array(runtimeWorkspaceFileSearchMatchSchema),
});
export type RuntimeWorkspaceFileSearchResponse = z.infer<typeof runtimeWorkspaceFileSearchResponseSchema>;

export const runtimeListFilesRequestSchema = z.object({
	taskId: z.string().nullable(),
	baseRef: z.string().optional(),
	ref: z.string().optional(),
});
export type RuntimeListFilesRequest = z.infer<typeof runtimeListFilesRequestSchema>;

export const runtimeListFilesResponseSchema = z.object({
	files: z.array(z.string()),
});
export type RuntimeListFilesResponse = z.infer<typeof runtimeListFilesResponseSchema>;

export const runtimeFileContentRequestSchema = z.object({
	taskId: z.string().nullable(),
	baseRef: z.string().optional(),
	path: z.string().min(1),
	ref: z.string().optional(),
});
export type RuntimeFileContentRequest = z.infer<typeof runtimeFileContentRequestSchema>;

export const runtimeFileContentResponseSchema = z.object({
	content: z.string(),
	language: z.string(),
	binary: z.boolean(),
	size: z.number(),
	truncated: z.boolean(),
});
export type RuntimeFileContentResponse = z.infer<typeof runtimeFileContentResponseSchema>;

export const runtimeWorkspaceTextSearchRequestSchema = z.object({
	query: z.string().min(1).max(500),
	caseSensitive: z.boolean().optional(),
	isRegex: z.boolean().optional(),
	limit: z.number().int().positive().max(500).optional(),
});
export type RuntimeWorkspaceTextSearchRequest = z.infer<typeof runtimeWorkspaceTextSearchRequestSchema>;

export const runtimeWorkspaceTextSearchMatchSchema = z.object({
	line: z.number().int().nonnegative(),
	content: z.string(),
});
export type RuntimeWorkspaceTextSearchMatch = z.infer<typeof runtimeWorkspaceTextSearchMatchSchema>;

export const runtimeWorkspaceTextSearchFileSchema = z.object({
	path: z.string(),
	matches: z.array(runtimeWorkspaceTextSearchMatchSchema),
});
export type RuntimeWorkspaceTextSearchFile = z.infer<typeof runtimeWorkspaceTextSearchFileSchema>;

export const runtimeWorkspaceTextSearchResponseSchema = z.object({
	query: z.string(),
	files: z.array(runtimeWorkspaceTextSearchFileSchema),
	totalMatches: z.number().int().nonnegative(),
	truncated: z.boolean(),
});
export type RuntimeWorkspaceTextSearchResponse = z.infer<typeof runtimeWorkspaceTextSearchResponseSchema>;
