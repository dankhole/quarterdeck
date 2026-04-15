import type {
	RuntimeAutoMergedFilesRequest,
	RuntimeAutoMergedFilesResponse,
	RuntimeCommandRunRequest,
	RuntimeCommandRunResponse,
	RuntimeConfigResponse,
	RuntimeConfigSaveRequest,
	RuntimeConflictAbortRequest,
	RuntimeConflictAbortResponse,
	RuntimeConflictContinueRequest,
	RuntimeConflictContinueResponse,
	RuntimeConflictFilesRequest,
	RuntimeConflictFilesResponse,
	RuntimeConflictResolveRequest,
	RuntimeFileContentRequest,
	RuntimeFileContentResponse,
	RuntimeFileDiffRequest,
	RuntimeFileDiffResponse,
	RuntimeGitCheckoutRequest,
	RuntimeGitCheckoutResponse,
	RuntimeGitCherryPickRequest,
	RuntimeGitCherryPickResponse,
	RuntimeGitCommitDiffRequest,
	RuntimeGitCommitDiffResponse,
	RuntimeGitCommitRequest,
	RuntimeGitCommitResponse,
	RuntimeGitCreateBranchRequest,
	RuntimeGitCreateBranchResponse,
	RuntimeGitDeleteBranchRequest,
	RuntimeGitDeleteBranchResponse,
	RuntimeGitDiscardFileRequest,
	RuntimeGitDiscardResponse,
	RuntimeGitLogRequest,
	RuntimeGitLogResponse,
	RuntimeGitMergeRequest,
	RuntimeGitMergeResponse,
	RuntimeGitRefsResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeListFilesRequest,
	RuntimeListFilesResponse,
	RuntimeMigrateTaskWorkingDirectoryRequest,
	RuntimeMigrateTaskWorkingDirectoryResponse,
	RuntimeOpenFileRequest,
	RuntimeOpenFileResponse,
	RuntimeProjectAddRequest,
	RuntimeProjectAddResponse,
	RuntimeProjectDirectoryPickerResponse,
	RuntimeProjectRemoveRequest,
	RuntimeProjectRemoveResponse,
	RuntimeProjectReorderRequest,
	RuntimeProjectReorderResponse,
	RuntimeProjectsResponse,
	RuntimeShellSessionStartRequest,
	RuntimeShellSessionStartResponse,
	RuntimeStashDropResponse,
	RuntimeStashListResponse,
	RuntimeStashPopApplyResponse,
	RuntimeStashPushResponse,
	RuntimeStashShowResponse,
	RuntimeTaskSessionInputRequest,
	RuntimeTaskSessionInputResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionStopRequest,
	RuntimeTaskSessionStopResponse,
	RuntimeTaskWorkspaceInfoRequest,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeWorkspaceChangesRequest,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileSearchRequest,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateNotifyResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
	RuntimeWorktreeDeleteRequest,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureRequest,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";

export interface RuntimeTrpcWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface RuntimeTrpcContext {
	requestedWorkspaceId: string | null;
	workspaceScope: RuntimeTrpcWorkspaceScope | null;
	runtimeApi: {
		loadConfig: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeConfigResponse>;
		saveConfig: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeConfigSaveRequest,
		) => Promise<RuntimeConfigResponse>;
		startTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStartRequest,
		) => Promise<RuntimeTaskSessionStartResponse>;
		stopTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStopRequest,
		) => Promise<RuntimeTaskSessionStopResponse>;
		sendTaskSessionInput: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionInputRequest,
		) => Promise<RuntimeTaskSessionInputResponse>;
		startShellSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeShellSessionStartRequest,
		) => Promise<RuntimeShellSessionStartResponse>;
		runCommand: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeCommandRunRequest,
		) => Promise<RuntimeCommandRunResponse>;
		openFile: (input: RuntimeOpenFileRequest) => Promise<RuntimeOpenFileResponse>;
		migrateTaskWorkingDirectory: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeMigrateTaskWorkingDirectoryRequest,
		) => Promise<RuntimeMigrateTaskWorkingDirectoryResponse>;
		setLogLevel: (level: "debug" | "info" | "warn" | "error") => {
			ok: boolean;
			level: "debug" | "info" | "warn" | "error";
		};
		flagTaskForDebug: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskId: string; note?: string },
		) => Promise<{ ok: boolean }>;
	};
	workspaceApi: {
		loadGitSummary: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitSummaryResponse>;
		runGitSyncAction: (
			scope: RuntimeTrpcWorkspaceScope,
			input: {
				action: RuntimeGitSyncAction;
				taskScope?: RuntimeTaskWorkspaceInfoRequest | null;
				branch?: string | null;
			},
		) => Promise<RuntimeGitSyncResponse>;
		checkoutGitBranch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCheckoutRequest,
		) => Promise<RuntimeGitCheckoutResponse>;
		mergeBranch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitMergeRequest,
		) => Promise<RuntimeGitMergeResponse>;
		getConflictFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConflictFilesRequest,
		) => Promise<RuntimeConflictFilesResponse>;
		getAutoMergedFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeAutoMergedFilesRequest,
		) => Promise<RuntimeAutoMergedFilesResponse>;
		resolveConflictFile: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConflictResolveRequest,
		) => Promise<{ ok: boolean; error?: string }>;
		continueConflictResolution: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConflictContinueRequest,
		) => Promise<RuntimeConflictContinueResponse>;
		abortConflictResolution: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConflictAbortRequest,
		) => Promise<RuntimeConflictAbortResponse>;
		createBranch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCreateBranchRequest,
		) => Promise<RuntimeGitCreateBranchResponse>;
		deleteBranch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitDeleteBranchRequest,
		) => Promise<RuntimeGitDeleteBranchResponse>;
		cherryPickCommit: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCherryPickRequest,
		) => Promise<RuntimeGitCherryPickResponse>;
		discardGitChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitDiscardResponse>;
		commitSelectedFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCommitRequest,
		) => Promise<RuntimeGitCommitResponse>;
		discardFile: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitDiscardFileRequest,
		) => Promise<RuntimeGitDiscardResponse>;
		loadChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceChangesRequest,
		) => Promise<RuntimeWorkspaceChangesResponse>;
		loadFileDiff: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFileDiffRequest,
		) => Promise<RuntimeFileDiffResponse>;
		ensureWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeEnsureRequest,
		) => Promise<RuntimeWorktreeEnsureResponse>;
		deleteWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeDeleteRequest,
		) => Promise<RuntimeWorktreeDeleteResponse>;
		loadTaskContext: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest,
		) => Promise<RuntimeTaskWorkspaceInfoResponse>;
		searchFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceFileSearchRequest,
		) => Promise<RuntimeWorkspaceFileSearchResponse>;
		listFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeListFilesRequest,
		) => Promise<RuntimeListFilesResponse>;
		getFileContent: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFileContentRequest,
		) => Promise<RuntimeFileContentResponse>;
		loadState: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateResponse>;
		notifyStateUpdated: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateNotifyResponse>;
		saveState: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceStateSaveRequest,
		) => Promise<RuntimeWorkspaceStateResponse>;
		loadWorkspaceChanges: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceChangesResponse>;
		loadGitLog: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeGitLogRequest) => Promise<RuntimeGitLogResponse>;
		loadGitRefs: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitRefsResponse>;
		loadCommitDiff: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCommitDiffRequest,
		) => Promise<RuntimeGitCommitDiffResponse>;
		getDiffText: (
			scope: RuntimeTrpcWorkspaceScope,
			taskScope: { taskId: string; baseRef: string } | null,
			paths?: string[],
		) => Promise<string>;
		notifyTaskTitleUpdated: (scope: RuntimeTrpcWorkspaceScope, taskId: string, title: string) => void;
		setTaskDisplaySummary: (
			scope: RuntimeTrpcWorkspaceScope,
			taskId: string,
			text: string,
			generatedAt: number | null,
		) => Promise<void>;
		setFocusedTask: (scope: RuntimeTrpcWorkspaceScope, taskId: string | null) => void;
		stashPush: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskScope: { taskId: string; baseRef: string } | null; paths: string[]; message?: string },
		) => Promise<RuntimeStashPushResponse>;
		stashList: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskScope: { taskId: string; baseRef: string } | null },
		) => Promise<RuntimeStashListResponse>;
		stashPop: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskScope: { taskId: string; baseRef: string } | null; index: number },
		) => Promise<RuntimeStashPopApplyResponse>;
		stashApply: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskScope: { taskId: string; baseRef: string } | null; index: number },
		) => Promise<RuntimeStashPopApplyResponse>;
		stashDrop: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskScope: { taskId: string; baseRef: string } | null; index: number },
		) => Promise<RuntimeStashDropResponse>;
		stashShow: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskScope: { taskId: string; baseRef: string } | null; index: number },
		) => Promise<RuntimeStashShowResponse>;
	};
	projectsApi: {
		listProjects: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectsResponse>;
		addProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectAddRequest,
		) => Promise<RuntimeProjectAddResponse>;
		removeProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectRemoveRequest,
		) => Promise<RuntimeProjectRemoveResponse>;
		pickProjectDirectory: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectDirectoryPickerResponse>;
		reorderProjects: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectReorderRequest,
		) => Promise<RuntimeProjectReorderResponse>;
	};
	hooksApi: {
		ingest: (input: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>;
	};
}

export interface RuntimeTrpcContextWithWorkspaceScope extends RuntimeTrpcContext {
	workspaceScope: RuntimeTrpcWorkspaceScope;
}
