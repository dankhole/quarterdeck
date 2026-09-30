import { z } from "zod";
import { runtimeBoardDataSchema } from "./board.js";
import { runtimeConflictStateSchema } from "./git-merge.js";
import { runtimeGitRepositoryInfoSchema, runtimeGitSyncSummarySchema } from "./git-sync.js";
import { runtimeHostIntegrationFailureReasonSchema } from "./host-integrations.js";
import { projectOrganizationSchema } from "./project-organization.js";
import { runtimeTaskSessionSummarySchema } from "./task-session.js";

export const runtimeProjectTaskCountsSchema = z.object({
	in_progress: z.number(),
	review: z.number(),
	trash: z.number(),
});
export type RuntimeProjectTaskCounts = z.infer<typeof runtimeProjectTaskCountsSchema>;

export const runtimeProjectAvailabilitySchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("available") }),
	z.object({
		status: z.literal("unavailable"),
		reason: z.enum([
			"missing",
			"inaccessible",
			"not_directory",
			"not_git_repository",
			"invalid_location",
			"relocation_pending",
		]),
	}),
]);
export type RuntimeProjectAvailability = z.infer<typeof runtimeProjectAvailabilitySchema>;

export const runtimeProjectDisplayNameSchema = z
	.string()
	.trim()
	.min(1, "Project name cannot be empty.")
	.max(120, "Project name cannot exceed 120 characters.")
	.refine(
		(name) => !/[\p{Cc}\u2028\u2029]/u.test(name),
		"Project name must be a single line without control characters.",
	);

export const runtimeProjectSummarySchema = z.object({
	id: z.string(),
	path: z.string(),
	name: z.string(),
	displayName: runtimeProjectDisplayNameSchema.optional(),
	metadataRevision: z.number().int().nonnegative().optional(),
	availability: runtimeProjectAvailabilitySchema.optional(),
	folderOnly: z.boolean().optional(),
	boardRevision: z.number().int().nonnegative(),
	taskCounts: runtimeProjectTaskCountsSchema,
});
export type RuntimeProjectSummary = z.infer<typeof runtimeProjectSummarySchema>;

export const runtimeTaskWorktreeMetadataSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
	changedFiles: z.number().nullable(),
	additions: z.number().nullable(),
	deletions: z.number().nullable(),
	hasUnmergedChanges: z.boolean().nullable(),
	behindBaseCount: z.number().nullable(),
	behindRemoteBaseCount: z.number().nullable(),
	conflictState: runtimeConflictStateSchema.nullable().optional(),
	stateVersion: z.number().int().nonnegative(),
});
export type RuntimeTaskWorktreeMetadata = z.infer<typeof runtimeTaskWorktreeMetadataSchema>;

export const runtimeProjectMetadataSchema = z.object({
	metadataRevision: z.number().int().nonnegative().optional(),
	homeGitSummary: runtimeGitSyncSummarySchema.nullable(),
	homeGitStateVersion: z.number().int().nonnegative(),
	homeConflictState: runtimeConflictStateSchema.nullable().optional(),
	homeStashCount: z.number().int().nonnegative(),
	taskWorktrees: z.array(runtimeTaskWorktreeMetadataSchema),
});
export type RuntimeProjectMetadata = z.infer<typeof runtimeProjectMetadataSchema>;

export const runtimeProjectStateWarningSchema = z.object({
	kind: z.literal("sessions_corruption"),
	droppedCount: z.number().int().nonnegative(),
	backupPath: z.string().nullable(),
});
export type RuntimeProjectStateWarning = z.infer<typeof runtimeProjectStateWarningSchema>;

export const runtimeProjectStateResponseSchema = z.object({
	repoPath: z.string(),
	statePath: z.string(),
	git: runtimeGitRepositoryInfoSchema,
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	revision: z.number(),
	metadataRevision: z.number().int().nonnegative().optional(),
	availability: runtimeProjectAvailabilitySchema.optional(),
	warnings: z.array(runtimeProjectStateWarningSchema).optional(),
});
export type RuntimeProjectStateResponse = z.infer<typeof runtimeProjectStateResponseSchema>;

export const runtimeProjectsResponseSchema = z.object({
	organization: projectOrganizationSchema.nullable().optional(),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeProjectsResponse = z.infer<typeof runtimeProjectsResponseSchema>;

export const runtimeProjectAddRequestSchema = z.object({
	groupId: z.string().optional(),
	path: z.string(),
	initializeGit: z.boolean().optional(),
	folderOnly: z.boolean().optional(),
});
export type RuntimeProjectAddRequest = z.infer<typeof runtimeProjectAddRequestSchema>;

export const runtimeProjectAddResponseSchema = z.object({
	ok: z.boolean(),
	project: runtimeProjectSummarySchema.nullable(),
	requiresGitInitialization: z.boolean().optional(),
	error: z.string().optional(),
});
export type RuntimeProjectAddResponse = z.infer<typeof runtimeProjectAddResponseSchema>;

export const runtimeProjectRenameRequestSchema = z.object({
	projectId: z.string().min(1),
	name: runtimeProjectDisplayNameSchema.nullable(),
});
export type RuntimeProjectRenameRequest = z.infer<typeof runtimeProjectRenameRequestSchema>;

export const runtimeProjectLocateRequestSchema = z.object({
	projectId: z.string().min(1),
	expectedPath: z.string().min(1),
	path: z.string().min(1),
});
export type RuntimeProjectLocateRequest = z.infer<typeof runtimeProjectLocateRequestSchema>;

export const runtimeProjectRenameFolderRequestSchema = z.object({
	projectId: z.string().min(1),
	expectedPath: z.string().min(1),
	folderName: z.string().min(1),
});
export type RuntimeProjectRenameFolderRequest = z.infer<typeof runtimeProjectRenameFolderRequestSchema>;

export const runtimeProjectCheckAvailabilityRequestSchema = z.object({
	projectId: z.string().min(1),
});
export type RuntimeProjectCheckAvailabilityRequest = z.infer<typeof runtimeProjectCheckAvailabilityRequestSchema>;

export const runtimeProjectManagementResponseSchema = z.object({
	ok: z.boolean(),
	project: runtimeProjectSummarySchema.nullable(),
	state: runtimeProjectStateResponseSchema.optional(),
	error: z.string().optional(),
});
export type RuntimeProjectManagementResponse = z.infer<typeof runtimeProjectManagementResponseSchema>;

export const runtimeProjectDirectoryPickerFailureReasonSchema = z.union([
	z.literal("cancelled"),
	runtimeHostIntegrationFailureReasonSchema,
]);
export type RuntimeProjectDirectoryPickerFailureReason = z.infer<
	typeof runtimeProjectDirectoryPickerFailureReasonSchema
>;

export const runtimeProjectDirectoryPickerResponseSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		path: z.string().min(1),
		outcome: z.literal("native"),
	}),
	z.object({
		ok: z.literal(false),
		path: z.null(),
		reason: runtimeProjectDirectoryPickerFailureReasonSchema,
		error: z.string(),
	}),
]);
export type RuntimeProjectDirectoryPickerResponse = z.infer<typeof runtimeProjectDirectoryPickerResponseSchema>;

export const runtimeProjectRemoveRequestSchema = z.object({
	projectId: z.string(),
});
export type RuntimeProjectRemoveRequest = z.infer<typeof runtimeProjectRemoveRequestSchema>;

export const runtimeProjectRemoveResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeProjectRemoveResponse = z.infer<typeof runtimeProjectRemoveResponseSchema>;

export const runtimeProjectReorderRequestSchema = z.object({
	projectOrder: z.array(z.string()),
});
export type RuntimeProjectReorderRequest = z.infer<typeof runtimeProjectReorderRequestSchema>;

export const runtimeProjectReorderResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeProjectReorderResponse = z.infer<typeof runtimeProjectReorderResponseSchema>;

export const runtimeWorktreeEnsureRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	branch: z.string().min(1).nullable().optional(),
});
export type RuntimeWorktreeEnsureRequest = z.infer<typeof runtimeWorktreeEnsureRequestSchema>;

export const runtimeWorktreeEnsureResponseSchema = z.union([
	z.object({
		ok: z.literal(true),
		path: z.string(),
		baseRef: z.string(),
		baseCommit: z.string(),
		branch: z.string().nullable().optional(),
		warning: z.string().optional(),
		error: z.string().optional(),
	}),
	z.object({
		ok: z.literal(false),
		path: z.null(),
		baseRef: z.string(),
		baseCommit: z.null(),
		error: z.string().optional(),
	}),
]);
export type RuntimeWorktreeEnsureResponse = z.infer<typeof runtimeWorktreeEnsureResponseSchema>;

export const runtimeWorktreeDeleteRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeWorktreeDeleteRequest = z.infer<typeof runtimeWorktreeDeleteRequestSchema>;

export const runtimeWorktreeDeleteResponseSchema = z.object({
	ok: z.boolean(),
	removed: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeWorktreeDeleteResponse = z.infer<typeof runtimeWorktreeDeleteResponseSchema>;

export const runtimeTaskRepositoryInfoResponseSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
});
export type RuntimeTaskRepositoryInfoResponse = z.infer<typeof runtimeTaskRepositoryInfoResponseSchema>;
