import { z } from "zod";
import { runtimeWorkdirFileStatusSchema } from "./shared.js";

export const runtimeWorkdirFileChangeSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: runtimeWorkdirFileStatusSchema,
	additions: z.number(),
	deletions: z.number(),
	oldText: z.string().nullable(),
	newText: z.string().nullable(),
	contentRevision: z.string().optional(),
});
export type RuntimeWorkdirFileChange = z.infer<typeof runtimeWorkdirFileChangeSchema>;

export const runtimeDiffModeSchema = z.enum(["two_dot", "three_dot"]);
export type RuntimeDiffMode = z.infer<typeof runtimeDiffModeSchema>;

export const runtimeWorkdirChangesRequestSchema = z.object({
	taskId: z.string().nullable(),
	baseRef: z.string().optional(),
	mode: z.enum(["working_copy", "last_turn"]).optional(),
	fromRef: z.string().optional(),
	toRef: z.string().optional(),
	diffMode: runtimeDiffModeSchema.optional(),
});
export type RuntimeWorkdirChangesRequest = z.infer<typeof runtimeWorkdirChangesRequestSchema>;

export const runtimeWorkdirChangesModeSchema = z.enum(["working_copy", "last_turn"]);
export type RuntimeWorkdirChangesMode = z.infer<typeof runtimeWorkdirChangesModeSchema>;

export const runtimeWorkdirChangesResponseSchema = z.object({
	repoRoot: z.string(),
	generatedAt: z.number(),
	files: z.array(runtimeWorkdirFileChangeSchema),
});
export type RuntimeWorkdirChangesResponse = z.infer<typeof runtimeWorkdirChangesResponseSchema>;

export const runtimeFileDiffRequestSchema = z.object({
	taskId: z.string().nullable(),
	baseRef: z.string().optional(),
	mode: runtimeWorkdirChangesModeSchema.optional(),
	fromRef: z.string().optional(),
	toRef: z.string().optional(),
	diffMode: runtimeDiffModeSchema.optional(),
	path: z.string().min(1),
	previousPath: z.string().optional(),
	status: runtimeWorkdirFileStatusSchema,
});
export type RuntimeFileDiffRequest = z.infer<typeof runtimeFileDiffRequestSchema>;

export const runtimeFileDiffResponseSchema = z.object({
	path: z.string(),
	oldText: z.string().nullable(),
	newText: z.string().nullable(),
});
export type RuntimeFileDiffResponse = z.infer<typeof runtimeFileDiffResponseSchema>;

const runtimeWorkdirSearchScopeSchema = z.object({
	taskId: z.string().nullable().optional(),
	baseRef: z.string().optional(),
	ref: z.string().optional(),
});
export type RuntimeWorkdirSearchScope = z.infer<typeof runtimeWorkdirSearchScopeSchema>;

export const runtimeWorkdirFileSearchRequestSchema = runtimeWorkdirSearchScopeSchema.extend({
	query: z.string(),
	limit: z.number().int().positive().optional(),
});
export type RuntimeWorkdirFileSearchRequest = z.infer<typeof runtimeWorkdirFileSearchRequestSchema>;

export const runtimeWorkdirFileSearchMatchSchema = z.object({
	path: z.string(),
	name: z.string(),
	changed: z.boolean(),
});
export type RuntimeWorkdirFileSearchMatch = z.infer<typeof runtimeWorkdirFileSearchMatchSchema>;

export const runtimeWorkdirFileSearchResponseSchema = z.object({
	query: z.string(),
	files: z.array(runtimeWorkdirFileSearchMatchSchema),
});
export type RuntimeWorkdirFileSearchResponse = z.infer<typeof runtimeWorkdirFileSearchResponseSchema>;

export const runtimeListFilesRequestSchema = z.object({
	taskId: z.string().nullable(),
	baseRef: z.string().optional(),
	ref: z.string().optional(),
});
export type RuntimeListFilesRequest = z.infer<typeof runtimeListFilesRequestSchema>;

export const runtimeListFilesResponseSchema = z.object({
	files: z.array(z.string()),
	directories: z.array(z.string()).optional(),
	mutable: z.boolean().optional(),
	mutationBlockedReason: z.string().optional(),
});
export type RuntimeListFilesResponse = z.infer<typeof runtimeListFilesResponseSchema>;

export const runtimeWorkdirEntryKindSchema = z.enum(["file", "directory"]);
export type RuntimeWorkdirEntryKind = z.infer<typeof runtimeWorkdirEntryKindSchema>;

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
	contentHash: z.string().optional(),
	editable: z.boolean().optional(),
	editBlockedReason: z.string().optional(),
});
export type RuntimeFileContentResponse = z.infer<typeof runtimeFileContentResponseSchema>;

export const runtimeFileSaveRequestSchema = z.object({
	taskId: z.string().nullable(),
	baseRef: z.string().optional(),
	path: z.string().min(1),
	content: z.string(),
	expectedContentHash: z.string().min(1),
});
export type RuntimeFileSaveRequest = z.infer<typeof runtimeFileSaveRequestSchema>;

export const runtimeFileSaveResponseSchema = runtimeFileContentResponseSchema;
export type RuntimeFileSaveResponse = z.infer<typeof runtimeFileSaveResponseSchema>;

const runtimeMutableWorkdirEntryRequestBaseSchema = z.object({
	taskId: z.string().nullable(),
	baseRef: z.string().optional(),
	path: z.string().min(1),
	kind: runtimeWorkdirEntryKindSchema,
});

export const runtimeWorkdirEntryCreateRequestSchema = runtimeMutableWorkdirEntryRequestBaseSchema;
export type RuntimeWorkdirEntryCreateRequest = z.infer<typeof runtimeWorkdirEntryCreateRequestSchema>;

export const runtimeWorkdirEntryRenameRequestSchema = runtimeMutableWorkdirEntryRequestBaseSchema.extend({
	nextPath: z.string().min(1),
});
export type RuntimeWorkdirEntryRenameRequest = z.infer<typeof runtimeWorkdirEntryRenameRequestSchema>;

export const runtimeWorkdirEntryDeleteRequestSchema = runtimeMutableWorkdirEntryRequestBaseSchema;
export type RuntimeWorkdirEntryDeleteRequest = z.infer<typeof runtimeWorkdirEntryDeleteRequestSchema>;

export const runtimeWorkdirEntryMutationResponseSchema = z.object({
	ok: z.boolean(),
	path: z.string(),
	kind: runtimeWorkdirEntryKindSchema,
});
export type RuntimeWorkdirEntryMutationResponse = z.infer<typeof runtimeWorkdirEntryMutationResponseSchema>;

export const runtimeWorkdirTextSearchRequestSchema = runtimeWorkdirSearchScopeSchema.extend({
	query: z.string().min(1).max(500),
	caseSensitive: z.boolean().optional(),
	isRegex: z.boolean().optional(),
	limit: z.number().int().positive().max(500).optional(),
});
export type RuntimeWorkdirTextSearchRequest = z.infer<typeof runtimeWorkdirTextSearchRequestSchema>;

export const runtimeWorkdirTextSearchMatchSchema = z.object({
	line: z.number().int().nonnegative(),
	content: z.string(),
});
export type RuntimeWorkdirTextSearchMatch = z.infer<typeof runtimeWorkdirTextSearchMatchSchema>;

export const runtimeWorkdirTextSearchFileSchema = z.object({
	path: z.string(),
	matches: z.array(runtimeWorkdirTextSearchMatchSchema),
});
export type RuntimeWorkdirTextSearchFile = z.infer<typeof runtimeWorkdirTextSearchFileSchema>;

export const runtimeWorkdirTextSearchResponseSchema = z.object({
	query: z.string(),
	files: z.array(runtimeWorkdirTextSearchFileSchema),
	totalMatches: z.number().int().nonnegative(),
	truncated: z.boolean(),
});
export type RuntimeWorkdirTextSearchResponse = z.infer<typeof runtimeWorkdirTextSearchResponseSchema>;
