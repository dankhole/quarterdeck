import { z } from "zod";

export const runtimeWorkspaceFileStatusSchema = z.enum([
	"modified",
	"added",
	"deleted",
	"renamed",
	"copied",
	"untracked",
	"unknown",
]);
export type RuntimeWorkspaceFileStatus = z.infer<typeof runtimeWorkspaceFileStatusSchema>;

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

export const runtimeWorkspaceChangesRequestSchema = z.object({
	taskId: z.string().nullable(),
	baseRef: z.string().optional(),
	mode: z.enum(["working_copy", "last_turn"]).optional(),
	fromRef: z.string().optional(),
	toRef: z.string().optional(),
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

export const runtimeAgentIdSchema = z.enum(["claude", "codex", "gemini", "opencode"]);
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>;

export const runtimeBoardColumnIdSchema = z.enum(["backlog", "in_progress", "review", "trash"]);
export type RuntimeBoardColumnId = z.infer<typeof runtimeBoardColumnIdSchema>;

export const runtimeTaskAutoReviewModeSchema = z.enum(["commit", "pr", "move_to_trash"]);
export type RuntimeTaskAutoReviewMode = z.infer<typeof runtimeTaskAutoReviewModeSchema>;

export const runtimeTaskImageSchema = z.object({
	id: z.string(),
	data: z.string(),
	mimeType: z.string(),
	name: z.string().optional(),
});
export type RuntimeTaskImage = z.infer<typeof runtimeTaskImageSchema>;

export const runtimeBoardCardSchema = z.object({
	id: z.string(),
	title: z.string().nullable().default(null),
	prompt: z.string(),
	startInPlanMode: z.boolean(),
	autoReviewEnabled: z.boolean().optional(),
	autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
	images: z.array(runtimeTaskImageSchema).optional(),
	baseRef: z.string(),
	useWorktree: z.boolean().optional(),
	workingDirectory: z.string().min(1).nullable().optional(),
	branch: z.string().min(1).nullable().optional(),
	pinned: z.boolean().optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type RuntimeBoardCard = z.infer<typeof runtimeBoardCardSchema>;

export const runtimeBoardColumnSchema = z.object({
	id: runtimeBoardColumnIdSchema,
	title: z.string(),
	cards: z.array(runtimeBoardCardSchema),
});
export type RuntimeBoardColumn = z.infer<typeof runtimeBoardColumnSchema>;

export const runtimeBoardDependencySchema = z.object({
	id: z.string(),
	fromTaskId: z.string(),
	toTaskId: z.string(),
	createdAt: z.number(),
});
export type RuntimeBoardDependency = z.infer<typeof runtimeBoardDependencySchema>;

export const runtimeBoardDataSchema = z.object({
	columns: z.array(runtimeBoardColumnSchema),
	dependencies: z.array(runtimeBoardDependencySchema).default([]),
});
export type RuntimeBoardData = z.infer<typeof runtimeBoardDataSchema>;

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
});
export type RuntimeGitCheckoutResponse = z.infer<typeof runtimeGitCheckoutResponseSchema>;

export const runtimeGitDiscardResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitDiscardResponse = z.infer<typeof runtimeGitDiscardResponseSchema>;

export const runtimeTaskSessionStateSchema = z.enum(["idle", "running", "awaiting_review", "failed", "interrupted"]);
export type RuntimeTaskSessionState = z.infer<typeof runtimeTaskSessionStateSchema>;

export const runtimeTaskSessionModeSchema = z.enum(["act", "plan"]);
export type RuntimeTaskSessionMode = z.infer<typeof runtimeTaskSessionModeSchema>;

export const runtimeTaskSessionReviewReasonSchema = z
	.enum(["attention", "exit", "error", "interrupted", "hook"])
	.nullable();
export type RuntimeTaskSessionReviewReason = z.infer<typeof runtimeTaskSessionReviewReasonSchema>;

export const runtimeTaskHookActivitySchema = z.object({
	activityText: z.string().nullable().default(null),
	toolName: z.string().nullable().default(null),
	toolInputSummary: z.string().nullable().default(null),
	finalMessage: z.string().nullable().default(null),
	hookEventName: z.string().nullable().default(null),
	notificationType: z.string().nullable().default(null),
	source: z.string().nullable().default(null),
	conversationSummaryText: z.string().nullable().default(null),
});
export type RuntimeTaskHookActivity = z.infer<typeof runtimeTaskHookActivitySchema>;

export const conversationSummaryEntrySchema = z.object({
	/** The extracted assistant message text, capped at 500 chars. */
	text: z.string(),
	/** Timestamp when this summary was captured. */
	capturedAt: z.number(),
	/** Which session stop event produced this (first, latest, etc.). */
	sessionIndex: z.number().int().nonnegative(),
});
export type ConversationSummaryEntry = z.infer<typeof conversationSummaryEntrySchema>;

export const runtimeTaskTurnCheckpointSchema = z.object({
	turn: z.number().int().positive(),
	ref: z.string(),
	commit: z.string(),
	createdAt: z.number(),
});
export type RuntimeTaskTurnCheckpoint = z.infer<typeof runtimeTaskTurnCheckpointSchema>;

export const runtimeTaskSessionSummarySchema = z.object({
	taskId: z.string(),
	state: runtimeTaskSessionStateSchema,
	mode: runtimeTaskSessionModeSchema.nullable().optional(),
	agentId: runtimeAgentIdSchema.nullable(),
	workspacePath: z.string().nullable(),
	pid: z.number().nullable(),
	startedAt: z.number().nullable(),
	updatedAt: z.number(),
	lastOutputAt: z.number().nullable(),
	reviewReason: runtimeTaskSessionReviewReasonSchema,
	exitCode: z.number().nullable(),
	lastHookAt: z.number().nullable().default(null),
	latestHookActivity: runtimeTaskHookActivitySchema.nullable().default(null),
	warningMessage: z.string().nullable().optional(),
	latestTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	previousTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	conversationSummaries: z.array(conversationSummaryEntrySchema).default([]),
	displaySummary: z.string().nullable().default(null),
	displaySummaryGeneratedAt: z.number().nullable().default(null),
});
export type RuntimeTaskSessionSummary = z.infer<typeof runtimeTaskSessionSummarySchema>;

export const runtimeWorkspaceStateResponseSchema = z.object({
	repoPath: z.string(),
	statePath: z.string(),
	git: runtimeGitRepositoryInfoSchema,
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	revision: z.number(),
});
export type RuntimeWorkspaceStateResponse = z.infer<typeof runtimeWorkspaceStateResponseSchema>;

export const runtimeWorkspaceStateSaveRequestSchema = z.object({
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	expectedRevision: z.number().int().nonnegative().optional(),
});
export type RuntimeWorkspaceStateSaveRequest = z.infer<typeof runtimeWorkspaceStateSaveRequestSchema>;

export const runtimeWorkspaceStateConflictResponseSchema = z.object({
	error: z.string(),
	currentRevision: z.number(),
});
export type RuntimeWorkspaceStateConflictResponse = z.infer<typeof runtimeWorkspaceStateConflictResponseSchema>;

export const runtimeWorkspaceStateNotifyResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeWorkspaceStateNotifyResponse = z.infer<typeof runtimeWorkspaceStateNotifyResponseSchema>;

export const runtimeProjectTaskCountsSchema = z.object({
	backlog: z.number(),
	in_progress: z.number(),
	review: z.number(),
	trash: z.number(),
	needs_input: z.number(),
});
export type RuntimeProjectTaskCounts = z.infer<typeof runtimeProjectTaskCountsSchema>;

export const runtimeProjectSummarySchema = z.object({
	id: z.string(),
	path: z.string(),
	name: z.string(),
	taskCounts: runtimeProjectTaskCountsSchema,
});
export type RuntimeProjectSummary = z.infer<typeof runtimeProjectSummarySchema>;

export const runtimeTaskWorkspaceMetadataSchema = z.object({
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
	stateVersion: z.number().int().nonnegative(),
});
export type RuntimeTaskWorkspaceMetadata = z.infer<typeof runtimeTaskWorkspaceMetadataSchema>;

export const runtimeWorkspaceMetadataSchema = z.object({
	homeGitSummary: runtimeGitSyncSummarySchema.nullable(),
	homeGitStateVersion: z.number().int().nonnegative(),
	taskWorkspaces: z.array(runtimeTaskWorkspaceMetadataSchema),
});
export type RuntimeWorkspaceMetadata = z.infer<typeof runtimeWorkspaceMetadataSchema>;

export const runtimeStateStreamSnapshotMessageSchema = z.object({
	type: z.literal("snapshot"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
	workspaceState: runtimeWorkspaceStateResponseSchema.nullable(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema.nullable(),
});
export type RuntimeStateStreamSnapshotMessage = z.infer<typeof runtimeStateStreamSnapshotMessageSchema>;

export const runtimeStateStreamWorkspaceStateMessageSchema = z.object({
	type: z.literal("workspace_state_updated"),
	workspaceId: z.string(),
	workspaceState: runtimeWorkspaceStateResponseSchema,
});
export type RuntimeStateStreamWorkspaceStateMessage = z.infer<typeof runtimeStateStreamWorkspaceStateMessageSchema>;

export const runtimeStateStreamTaskSessionsMessageSchema = z.object({
	type: z.literal("task_sessions_updated"),
	workspaceId: z.string(),
	summaries: z.array(runtimeTaskSessionSummarySchema),
});
export type RuntimeStateStreamTaskSessionsMessage = z.infer<typeof runtimeStateStreamTaskSessionsMessageSchema>;

export const runtimeStateStreamProjectsMessageSchema = z.object({
	type: z.literal("projects_updated"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeStateStreamProjectsMessage = z.infer<typeof runtimeStateStreamProjectsMessageSchema>;

export const runtimeStateStreamWorkspaceMetadataMessageSchema = z.object({
	type: z.literal("workspace_metadata_updated"),
	workspaceId: z.string(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema,
});
export type RuntimeStateStreamWorkspaceMetadataMessage = z.infer<
	typeof runtimeStateStreamWorkspaceMetadataMessageSchema
>;

export const runtimeStateStreamTaskReadyForReviewMessageSchema = z.object({
	type: z.literal("task_ready_for_review"),
	workspaceId: z.string(),
	taskId: z.string(),
	triggeredAt: z.number(),
});
export type RuntimeStateStreamTaskReadyForReviewMessage = z.infer<
	typeof runtimeStateStreamTaskReadyForReviewMessageSchema
>;

export const runtimeStateStreamTaskTitleUpdatedMessageSchema = z.object({
	type: z.literal("task_title_updated"),
	workspaceId: z.string(),
	taskId: z.string(),
	title: z.string(),
	autoGenerated: z.boolean().optional(),
});
export type RuntimeStateStreamTaskTitleUpdatedMessage = z.infer<typeof runtimeStateStreamTaskTitleUpdatedMessageSchema>;

export const runtimeStateStreamTaskNotificationMessageSchema = z.object({
	type: z.literal("task_notification"),
	// Included for consistency with other message schemas and to support future
	// per-workspace notification settings (currently out of scope).
	workspaceId: z.string(),
	summaries: z.array(runtimeTaskSessionSummarySchema),
});
export type RuntimeStateStreamTaskNotificationMessage = z.infer<typeof runtimeStateStreamTaskNotificationMessageSchema>;

export const runtimeStateStreamErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeStateStreamErrorMessage = z.infer<typeof runtimeStateStreamErrorMessageSchema>;

export const runtimeDebugLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type RuntimeDebugLogLevel = z.infer<typeof runtimeDebugLogLevelSchema>;

export const runtimeDebugLogEntrySchema = z.object({
	id: z.string(),
	timestamp: z.number(),
	level: runtimeDebugLogLevelSchema,
	tag: z.string(),
	message: z.string(),
	data: z.unknown().optional(),
	source: z.enum(["server", "client"]),
});
export type RuntimeDebugLogEntry = z.infer<typeof runtimeDebugLogEntrySchema>;

export const runtimeStateStreamDebugLogBatchMessageSchema = z.object({
	type: z.literal("debug_log_batch"),
	entries: z.array(runtimeDebugLogEntrySchema),
});
export type RuntimeStateStreamDebugLogBatchMessage = z.infer<typeof runtimeStateStreamDebugLogBatchMessageSchema>;

export const runtimeStateStreamDebugLoggingStateMessageSchema = z.object({
	type: z.literal("debug_logging_state"),
	enabled: z.boolean(),
	recentEntries: z.array(runtimeDebugLogEntrySchema).optional(),
});
export type RuntimeStateStreamDebugLoggingStateMessage = z.infer<
	typeof runtimeStateStreamDebugLoggingStateMessageSchema
>;

export const runtimeStateStreamMessageSchema = z.discriminatedUnion("type", [
	runtimeStateStreamSnapshotMessageSchema,
	runtimeStateStreamWorkspaceStateMessageSchema,
	runtimeStateStreamTaskSessionsMessageSchema,
	runtimeStateStreamProjectsMessageSchema,
	runtimeStateStreamWorkspaceMetadataMessageSchema,
	runtimeStateStreamTaskReadyForReviewMessageSchema,
	runtimeStateStreamTaskTitleUpdatedMessageSchema,
	runtimeStateStreamTaskNotificationMessageSchema,
	runtimeStateStreamErrorMessageSchema,
	runtimeStateStreamDebugLogBatchMessageSchema,
	runtimeStateStreamDebugLoggingStateMessageSchema,
]);
export type RuntimeStateStreamMessage = z.infer<typeof runtimeStateStreamMessageSchema>;

export const runtimeProjectsResponseSchema = z.object({
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeProjectsResponse = z.infer<typeof runtimeProjectsResponseSchema>;

export const runtimeProjectAddRequestSchema = z.object({
	path: z.string(),
	initializeGit: z.boolean().optional(),
});
export type RuntimeProjectAddRequest = z.infer<typeof runtimeProjectAddRequestSchema>;

export const runtimeProjectAddResponseSchema = z.object({
	ok: z.boolean(),
	project: runtimeProjectSummarySchema.nullable(),
	requiresGitInitialization: z.boolean().optional(),
	error: z.string().optional(),
});
export type RuntimeProjectAddResponse = z.infer<typeof runtimeProjectAddResponseSchema>;

export const runtimeProjectDirectoryPickerResponseSchema = z.object({
	ok: z.boolean(),
	path: z.string().nullable(),
	error: z.string().optional(),
});
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

export const runtimeTaskWorkspaceInfoRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeTaskWorkspaceInfoRequest = z.infer<typeof runtimeTaskWorkspaceInfoRequestSchema>;

export const runtimeTaskWorkspaceInfoResponseSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
});
export type RuntimeTaskWorkspaceInfoResponse = z.infer<typeof runtimeTaskWorkspaceInfoResponseSchema>;

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

export const runtimeCommandRunRequestSchema = z.object({
	command: z.string(),
});
export type RuntimeCommandRunRequest = z.infer<typeof runtimeCommandRunRequestSchema>;

export const runtimeCommandRunResponseSchema = z.object({
	exitCode: z.number(),
	stdout: z.string(),
	stderr: z.string(),
	combinedOutput: z.string(),
	durationMs: z.number(),
});
export type RuntimeCommandRunResponse = z.infer<typeof runtimeCommandRunResponseSchema>;

export const runtimeOpenFileRequestSchema = z.object({
	filePath: z.string(),
});
export type RuntimeOpenFileRequest = z.infer<typeof runtimeOpenFileRequestSchema>;

export const runtimeOpenFileResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeOpenFileResponse = z.infer<typeof runtimeOpenFileResponseSchema>;

export const runtimeDebugResetAllStateResponseSchema = z.object({
	ok: z.boolean(),
	clearedPaths: z.array(z.string()),
});
export type RuntimeDebugResetAllStateResponse = z.infer<typeof runtimeDebugResetAllStateResponseSchema>;

export const runtimeAgentDefinitionSchema = z.object({
	id: runtimeAgentIdSchema,
	label: z.string(),
	binary: z.string(),
	command: z.string(),
	defaultArgs: z.array(z.string()),
	installed: z.boolean(),
	configured: z.boolean(),
});
export type RuntimeAgentDefinition = z.infer<typeof runtimeAgentDefinitionSchema>;

export const runtimeConfigResponseSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema,
	selectedShortcutLabel: z.string().nullable(),
	agentAutonomousModeEnabled: z.boolean(),
	debugModeEnabled: z.boolean().optional(),
	effectiveCommand: z.string().nullable(),
	globalConfigPath: z.string(),
	projectConfigPath: z.string().nullable(),
	readyForReviewNotificationsEnabled: z.boolean(),
	shellAutoRestartEnabled: z.boolean(),
	showTrashWorktreeNotice: z.boolean(),
	uncommittedChangesOnCardsEnabled: z.boolean(),
	unmergedChangesIndicatorEnabled: z.boolean(),
	behindBaseIndicatorEnabled: z.boolean(),
	skipTaskCheckoutConfirmation: z.boolean(),
	skipHomeCheckoutConfirmation: z.boolean(),
	audibleNotificationsEnabled: z.boolean(),
	audibleNotificationVolume: z.number().min(0).max(1),
	audibleNotificationEvents: z.object({
		permission: z.boolean(),
		review: z.boolean(),
		failure: z.boolean(),
		completion: z.boolean(),
	}),
	audibleNotificationsOnlyWhenHidden: z.boolean(),
	commitPromptTemplate: z.string(),
	openPrPromptTemplate: z.string(),
	commitPromptTemplateDefault: z.string(),
	openPrPromptTemplateDefault: z.string(),
	detectedCommands: z.array(z.string()),
	agents: z.array(runtimeAgentDefinitionSchema),
	shortcuts: z.array(runtimeProjectShortcutSchema),
	promptShortcuts: z.array(promptShortcutSchema),
	hiddenDefaultPromptShortcuts: z.array(z.string()),
	showSummaryOnCards: z.boolean(),
	autoGenerateSummary: z.boolean(),
	summaryStaleAfterSeconds: z.number(),
	focusedTaskPollMs: z.number(),
	backgroundTaskPollMs: z.number(),
	homeRepoPollMs: z.number(),
	statuslineEnabled: z.boolean(),
	terminalFontWeight: z.number(),
	terminalWebGLRenderer: z.boolean(),
	terminalChatViewEnabled: z.boolean(),
	worktreeAddParentRepoDir: z.boolean(),
	worktreeAddQuarterdeckDir: z.boolean(),
	showRunningTaskEmergencyActions: z.boolean(),
	llmConfigured: z.boolean(),
});
export type RuntimeConfigResponse = z.infer<typeof runtimeConfigResponseSchema>;

export const runtimeConfigSaveRequestSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema.optional(),
	selectedShortcutLabel: z.string().nullable().optional(),
	agentAutonomousModeEnabled: z.boolean().optional(),
	shortcuts: z.array(runtimeProjectShortcutSchema).optional(),
	promptShortcuts: z.array(promptShortcutSchema).optional(),
	hiddenDefaultPromptShortcuts: z.array(z.string()).optional(),
	readyForReviewNotificationsEnabled: z.boolean().optional(),
	shellAutoRestartEnabled: z.boolean().optional(),
	showSummaryOnCards: z.boolean().optional(),
	autoGenerateSummary: z.boolean().optional(),
	summaryStaleAfterSeconds: z.number().min(5).optional(),
	showTrashWorktreeNotice: z.boolean().optional(),
	uncommittedChangesOnCardsEnabled: z.boolean().optional(),
	unmergedChangesIndicatorEnabled: z.boolean().optional(),
	behindBaseIndicatorEnabled: z.boolean().optional(),
	skipTaskCheckoutConfirmation: z.boolean().optional(),
	skipHomeCheckoutConfirmation: z.boolean().optional(),
	commitPromptTemplate: z.string().optional(),
	openPrPromptTemplate: z.string().optional(),
	audibleNotificationsEnabled: z.boolean().optional(),
	audibleNotificationVolume: z.number().min(0).max(1).optional(),
	audibleNotificationEvents: z
		.object({
			permission: z.boolean(),
			review: z.boolean(),
			failure: z.boolean(),
			completion: z.boolean(),
		})
		.optional(),
	audibleNotificationsOnlyWhenHidden: z.boolean().optional(),
	focusedTaskPollMs: z.number().min(500).max(60000).optional(),
	backgroundTaskPollMs: z.number().min(500).max(60000).optional(),
	homeRepoPollMs: z.number().min(500).max(60000).optional(),
	statuslineEnabled: z.boolean().optional(),
	terminalFontWeight: z.number().min(100).max(900).optional(),
	terminalWebGLRenderer: z.boolean().optional(),
	terminalChatViewEnabled: z.boolean().optional(),
	worktreeAddParentRepoDir: z.boolean().optional(),
	worktreeAddQuarterdeckDir: z.boolean().optional(),
	showRunningTaskEmergencyActions: z.boolean().optional(),
});
export type RuntimeConfigSaveRequest = z.infer<typeof runtimeConfigSaveRequestSchema>;

export const runtimeTaskSessionStartRequestSchema = z.object({
	taskId: z.string(),
	prompt: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	startInPlanMode: z.boolean().optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
	resumeConversation: z.boolean().optional(),
	awaitReview: z.boolean().optional(),
	baseRef: z.string(),
	useWorktree: z.boolean().optional(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
});
export type RuntimeTaskSessionStartRequest = z.infer<typeof runtimeTaskSessionStartRequestSchema>;

export const runtimeTaskSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStartResponse = z.infer<typeof runtimeTaskSessionStartResponseSchema>;

export const runtimeTaskSessionStopRequestSchema = z.object({
	taskId: z.string(),
	waitForExit: z.boolean().optional(),
});
export type RuntimeTaskSessionStopRequest = z.infer<typeof runtimeTaskSessionStopRequestSchema>;

export const runtimeTaskSessionStopResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStopResponse = z.infer<typeof runtimeTaskSessionStopResponseSchema>;

export const runtimeTaskSessionInputRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	appendNewline: z.boolean().optional(),
});
export type RuntimeTaskSessionInputRequest = z.infer<typeof runtimeTaskSessionInputRequestSchema>;

export const runtimeTaskSessionInputResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionInputResponse = z.infer<typeof runtimeTaskSessionInputResponseSchema>;

export const runtimeMigrateTaskWorkingDirectoryRequestSchema = z.object({
	taskId: z.string(),
	direction: z.enum(["isolate", "de-isolate"]),
});
export type RuntimeMigrateTaskWorkingDirectoryRequest = z.infer<typeof runtimeMigrateTaskWorkingDirectoryRequestSchema>;

export const runtimeMigrateTaskWorkingDirectoryResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
	newWorkingDirectory: z.string().optional(),
});
export type RuntimeMigrateTaskWorkingDirectoryResponse = z.infer<
	typeof runtimeMigrateTaskWorkingDirectoryResponseSchema
>;

export const runtimeTaskChatMessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "system", "tool", "reasoning", "status"]),
	content: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	createdAt: z.number(),
	meta: z
		.object({
			toolName: z.string().nullable().optional(),
			hookEventName: z.string().nullable().optional(),
			toolCallId: z.string().nullable().optional(),
			streamType: z.string().nullable().optional(),
			messageKind: z.string().nullable().optional(),
			displayRole: z.string().nullable().optional(),
			reason: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
});
export type RuntimeTaskChatMessage = z.infer<typeof runtimeTaskChatMessageSchema>;

export const runtimeTaskChatMessagesRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatMessagesRequest = z.infer<typeof runtimeTaskChatMessagesRequestSchema>;

export const runtimeTaskChatMessagesResponseSchema = z.object({
	ok: z.boolean(),
	messages: z.array(runtimeTaskChatMessageSchema),
	error: z.string().optional(),
});
export type RuntimeTaskChatMessagesResponse = z.infer<typeof runtimeTaskChatMessagesResponseSchema>;

export const runtimeTaskChatSendRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
});
export type RuntimeTaskChatSendRequest = z.infer<typeof runtimeTaskChatSendRequestSchema>;

export const runtimeTaskChatSendResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	message: runtimeTaskChatMessageSchema.nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeTaskChatSendResponse = z.infer<typeof runtimeTaskChatSendResponseSchema>;

export const runtimeTaskChatReloadRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatReloadRequest = z.infer<typeof runtimeTaskChatReloadRequestSchema>;

export const runtimeTaskChatReloadResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatReloadResponse = z.infer<typeof runtimeTaskChatReloadResponseSchema>;

export const runtimeTaskChatAbortRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatAbortRequest = z.infer<typeof runtimeTaskChatAbortRequestSchema>;

export const runtimeTaskChatAbortResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatAbortResponse = z.infer<typeof runtimeTaskChatAbortResponseSchema>;

export const runtimeTaskChatCancelRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatCancelRequest = z.infer<typeof runtimeTaskChatCancelRequestSchema>;

export const runtimeTaskChatCancelResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatCancelResponse = z.infer<typeof runtimeTaskChatCancelResponseSchema>;

export const runtimeShellSessionStartRequestSchema = z.object({
	taskId: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	workspaceTaskId: z.string().optional(),
	baseRef: z.string(),
});
export type RuntimeShellSessionStartRequest = z.infer<typeof runtimeShellSessionStartRequestSchema>;

export const runtimeShellSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	shellBinary: z.string().nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeShellSessionStartResponse = z.infer<typeof runtimeShellSessionStartResponseSchema>;

export const runtimeTerminalWsResizeMessageSchema = z.object({
	type: z.literal("resize"),
	cols: z.number().int().positive(),
	rows: z.number().int().positive(),
	pixelWidth: z.number().int().positive().optional(),
	pixelHeight: z.number().int().positive().optional(),
});
export type RuntimeTerminalWsResizeMessage = z.infer<typeof runtimeTerminalWsResizeMessageSchema>;

export const runtimeTerminalWsStopMessageSchema = z.object({
	type: z.literal("stop"),
});
export type RuntimeTerminalWsStopMessage = z.infer<typeof runtimeTerminalWsStopMessageSchema>;

export const runtimeTerminalWsOutputAckMessageSchema = z.object({
	type: z.literal("output_ack"),
	bytes: z.number().int().nonnegative(),
});
export type RuntimeTerminalWsOutputAckMessage = z.infer<typeof runtimeTerminalWsOutputAckMessageSchema>;

export const runtimeTerminalWsRestoreCompleteMessageSchema = z.object({
	type: z.literal("restore_complete"),
});
export type RuntimeTerminalWsRestoreCompleteMessage = z.infer<typeof runtimeTerminalWsRestoreCompleteMessageSchema>;

export const runtimeTerminalWsClientMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsResizeMessageSchema,
	runtimeTerminalWsStopMessageSchema,
	runtimeTerminalWsOutputAckMessageSchema,
	runtimeTerminalWsRestoreCompleteMessageSchema,
]);
export type RuntimeTerminalWsClientMessage = z.infer<typeof runtimeTerminalWsClientMessageSchema>;

export const runtimeTerminalWsStateMessageSchema = z.object({
	type: z.literal("state"),
	summary: runtimeTaskSessionSummarySchema,
});
export type RuntimeTerminalWsStateMessage = z.infer<typeof runtimeTerminalWsStateMessageSchema>;

export const runtimeTerminalWsErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeTerminalWsErrorMessage = z.infer<typeof runtimeTerminalWsErrorMessageSchema>;

export const runtimeTerminalWsExitMessageSchema = z.object({
	type: z.literal("exit"),
	code: z.number().nullable(),
});
export type RuntimeTerminalWsExitMessage = z.infer<typeof runtimeTerminalWsExitMessageSchema>;

export const runtimeTerminalWsRestoreMessageSchema = z.object({
	type: z.literal("restore"),
	snapshot: z.string(),
	cols: z.number().int().positive().nullable().optional(),
	rows: z.number().int().positive().nullable().optional(),
});
export type RuntimeTerminalWsRestoreMessage = z.infer<typeof runtimeTerminalWsRestoreMessageSchema>;

export const runtimeTerminalWsServerMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsStateMessageSchema,
	runtimeTerminalWsErrorMessageSchema,
	runtimeTerminalWsExitMessageSchema,
	runtimeTerminalWsRestoreMessageSchema,
]);
export type RuntimeTerminalWsServerMessage = z.infer<typeof runtimeTerminalWsServerMessageSchema>;

export const runtimeGitCommitSchema = z.object({
	hash: z.string(),
	shortHash: z.string(),
	authorName: z.string(),
	authorEmail: z.string(),
	date: z.string(),
	message: z.string(),
	parentHashes: z.array(z.string()),
	relation: z.enum(["selected", "upstream", "shared"]).optional(),
});
export type RuntimeGitCommit = z.infer<typeof runtimeGitCommitSchema>;

export const runtimeGitRefSchema = z.object({
	name: z.string(),
	type: z.enum(["branch", "remote", "detached"]),
	hash: z.string(),
	isHead: z.boolean(),
	upstreamName: z.string().optional(),
	ahead: z.number().optional(),
	behind: z.number().optional(),
});
export type RuntimeGitRef = z.infer<typeof runtimeGitRefSchema>;

export const runtimeGitLogRequestSchema = z.object({
	ref: z.string().nullable().optional(),
	refs: z.array(z.string()).optional(),
	maxCount: z.number().int().positive().optional(),
	skip: z.number().int().nonnegative().optional(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitLogRequest = z.infer<typeof runtimeGitLogRequestSchema>;

export const runtimeGitLogResponseSchema = z.object({
	ok: z.boolean(),
	commits: z.array(runtimeGitCommitSchema),
	totalCount: z.number(),
	error: z.string().optional(),
});
export type RuntimeGitLogResponse = z.infer<typeof runtimeGitLogResponseSchema>;

export const runtimeGitCommitDiffFileSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: z.enum(["modified", "added", "deleted", "renamed"]),
	additions: z.number(),
	deletions: z.number(),
	patch: z.string(),
});
export type RuntimeGitCommitDiffFile = z.infer<typeof runtimeGitCommitDiffFileSchema>;

export const runtimeGitCommitDiffRequestSchema = z.object({
	commitHash: z.string(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitCommitDiffRequest = z.infer<typeof runtimeGitCommitDiffRequestSchema>;

export const runtimeGitCommitDiffResponseSchema = z.object({
	ok: z.boolean(),
	commitHash: z.string(),
	files: z.array(runtimeGitCommitDiffFileSchema),
	error: z.string().optional(),
});
export type RuntimeGitCommitDiffResponse = z.infer<typeof runtimeGitCommitDiffResponseSchema>;

export const runtimeGitRefsResponseSchema = z.object({
	ok: z.boolean(),
	refs: z.array(runtimeGitRefSchema),
	error: z.string().optional(),
});
export type RuntimeGitRefsResponse = z.infer<typeof runtimeGitRefsResponseSchema>;

export const runtimeHookEventSchema = z.enum(["to_review", "to_in_progress", "activity"]);
export type RuntimeHookEvent = z.infer<typeof runtimeHookEventSchema>;

export const runtimeHookIngestRequestSchema = z.object({
	taskId: z.string(),
	workspaceId: z.string(),
	event: runtimeHookEventSchema,
	metadata: runtimeTaskHookActivitySchema.partial().optional(),
});
export type RuntimeHookIngestRequest = z.infer<typeof runtimeHookIngestRequestSchema>;

export const runtimeHookIngestResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeHookIngestResponse = z.infer<typeof runtimeHookIngestResponseSchema>;
