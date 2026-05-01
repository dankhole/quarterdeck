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
	RuntimeFileSaveRequest,
	RuntimeFileSaveResponse,
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
	RuntimeGitRebaseRequest,
	RuntimeGitRebaseResponse,
	RuntimeGitRefsResponse,
	RuntimeGitRenameBranchRequest,
	RuntimeGitRenameBranchResponse,
	RuntimeGitResetToRefRequest,
	RuntimeGitResetToRefResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeListFilesRequest,
	RuntimeListFilesResponse,
	RuntimeOpenFileRequest,
	RuntimeOpenFileResponse,
	RuntimeProjectAddRequest,
	RuntimeProjectAddResponse,
	RuntimeProjectDirectoryPickerResponse,
	RuntimeProjectRemoveRequest,
	RuntimeProjectRemoveResponse,
	RuntimeProjectReorderRequest,
	RuntimeProjectReorderResponse,
	RuntimeProjectStateResponse,
	RuntimeProjectStateSaveRequest,
	RuntimeProjectsResponse,
	RuntimeShellSessionStartRequest,
	RuntimeShellSessionStartResponse,
	RuntimeStashDropResponse,
	RuntimeStashListResponse,
	RuntimeStashPopApplyResponse,
	RuntimeStashPushResponse,
	RuntimeStashShowResponse,
	RuntimeTaskRepositoryInfoResponse,
	RuntimeTaskSessionInputRequest,
	RuntimeTaskSessionInputResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionStopRequest,
	RuntimeTaskSessionStopResponse,
	RuntimeTaskWorktreeInfoRequest,
	RuntimeWorkdirChangesRequest,
	RuntimeWorkdirChangesResponse,
	RuntimeWorkdirEntryCreateRequest,
	RuntimeWorkdirEntryDeleteRequest,
	RuntimeWorkdirEntryMutationResponse,
	RuntimeWorkdirEntryRenameRequest,
	RuntimeWorkdirFileSearchRequest,
	RuntimeWorkdirFileSearchResponse,
	RuntimeWorkdirTextSearchRequest,
	RuntimeWorkdirTextSearchResponse,
	RuntimeWorktreeDeleteRequest,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureRequest,
	RuntimeWorktreeEnsureResponse,
} from "../core";
import type { RuntimeCommitMessageGenerationContext } from "../title";

export interface RuntimeTrpcProjectScope {
	projectId: string;
	projectPath: string;
}

export interface RuntimeTrpcContext {
	requestedProjectId: string | null;
	projectScope: RuntimeTrpcProjectScope | null;
	runtimeClientId: string;
	runtimeApi: {
		loadConfig: (scope: RuntimeTrpcProjectScope | null) => Promise<RuntimeConfigResponse>;
		saveConfig: (
			scope: RuntimeTrpcProjectScope | null,
			input: RuntimeConfigSaveRequest,
		) => Promise<RuntimeConfigResponse>;
		startTaskSession: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeTaskSessionStartRequest,
		) => Promise<RuntimeTaskSessionStartResponse>;
		stopTaskSession: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeTaskSessionStopRequest,
		) => Promise<RuntimeTaskSessionStopResponse>;
		sendTaskSessionInput: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeTaskSessionInputRequest,
		) => Promise<RuntimeTaskSessionInputResponse>;
		startShellSession: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeShellSessionStartRequest,
		) => Promise<RuntimeShellSessionStartResponse>;
		runCommand: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeCommandRunRequest,
		) => Promise<RuntimeCommandRunResponse>;
		openFile: (input: RuntimeOpenFileRequest) => Promise<RuntimeOpenFileResponse>;
		setLogLevel: (level: "debug" | "info" | "warn" | "error") => Promise<{
			ok: boolean;
			level: "debug" | "info" | "warn" | "error";
		}>;
	};
	projectApi: {
		runGitSyncAction: (
			scope: RuntimeTrpcProjectScope,
			input: {
				action: RuntimeGitSyncAction;
				taskScope?: RuntimeTaskWorktreeInfoRequest | null;
				branch?: string | null;
			},
		) => Promise<RuntimeGitSyncResponse>;
		checkoutGitBranch: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeGitCheckoutRequest,
		) => Promise<RuntimeGitCheckoutResponse>;
		mergeBranch: (scope: RuntimeTrpcProjectScope, input: RuntimeGitMergeRequest) => Promise<RuntimeGitMergeResponse>;
		getConflictFiles: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeConflictFilesRequest,
		) => Promise<RuntimeConflictFilesResponse>;
		getAutoMergedFiles: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeAutoMergedFilesRequest,
		) => Promise<RuntimeAutoMergedFilesResponse>;
		resolveConflictFile: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeConflictResolveRequest,
		) => Promise<{ ok: boolean; error?: string }>;
		continueConflictResolution: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeConflictContinueRequest,
		) => Promise<RuntimeConflictContinueResponse>;
		abortConflictResolution: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeConflictAbortRequest,
		) => Promise<RuntimeConflictAbortResponse>;
		createBranch: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeGitCreateBranchRequest,
		) => Promise<RuntimeGitCreateBranchResponse>;
		deleteBranch: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeGitDeleteBranchRequest,
		) => Promise<RuntimeGitDeleteBranchResponse>;
		renameBranch: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeGitRenameBranchRequest,
		) => Promise<RuntimeGitRenameBranchResponse>;
		rebaseBranch: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeGitRebaseRequest,
		) => Promise<RuntimeGitRebaseResponse>;
		resetToRef: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeGitResetToRefRequest,
		) => Promise<RuntimeGitResetToRefResponse>;
		cherryPickCommit: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeGitCherryPickRequest,
		) => Promise<RuntimeGitCherryPickResponse>;
		discardGitChanges: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeTaskWorktreeInfoRequest | null,
		) => Promise<RuntimeGitDiscardResponse>;
		commitSelectedFiles: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeGitCommitRequest,
		) => Promise<RuntimeGitCommitResponse>;
		discardFile: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeGitDiscardFileRequest,
		) => Promise<RuntimeGitDiscardResponse>;
		loadChanges: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeWorkdirChangesRequest,
		) => Promise<RuntimeWorkdirChangesResponse>;
		loadFileDiff: (scope: RuntimeTrpcProjectScope, input: RuntimeFileDiffRequest) => Promise<RuntimeFileDiffResponse>;
		ensureWorktree: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeWorktreeEnsureRequest,
		) => Promise<RuntimeWorktreeEnsureResponse>;
		deleteWorktree: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeWorktreeDeleteRequest,
		) => Promise<RuntimeWorktreeDeleteResponse>;
		loadTaskContext: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeTaskWorktreeInfoRequest,
		) => Promise<RuntimeTaskRepositoryInfoResponse>;
		searchFiles: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeWorkdirFileSearchRequest,
		) => Promise<RuntimeWorkdirFileSearchResponse>;
		searchText: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeWorkdirTextSearchRequest,
		) => Promise<RuntimeWorkdirTextSearchResponse>;
		listFiles: (scope: RuntimeTrpcProjectScope, input: RuntimeListFilesRequest) => Promise<RuntimeListFilesResponse>;
		getFileContent: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeFileContentRequest,
		) => Promise<RuntimeFileContentResponse>;
		saveFileContent: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeFileSaveRequest,
		) => Promise<RuntimeFileSaveResponse>;
		createWorkdirEntry: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeWorkdirEntryCreateRequest,
		) => Promise<RuntimeWorkdirEntryMutationResponse>;
		renameWorkdirEntry: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeWorkdirEntryRenameRequest,
		) => Promise<RuntimeWorkdirEntryMutationResponse>;
		deleteWorkdirEntry: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeWorkdirEntryDeleteRequest,
		) => Promise<RuntimeWorkdirEntryMutationResponse>;
		loadState: (scope: RuntimeTrpcProjectScope) => Promise<RuntimeProjectStateResponse>;
		saveState: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeProjectStateSaveRequest,
		) => Promise<RuntimeProjectStateResponse>;
		loadWorkdirChanges: (scope: RuntimeTrpcProjectScope) => Promise<RuntimeWorkdirChangesResponse>;
		loadGitLog: (scope: RuntimeTrpcProjectScope, input: RuntimeGitLogRequest) => Promise<RuntimeGitLogResponse>;
		loadGitRefs: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeTaskWorktreeInfoRequest | null,
		) => Promise<RuntimeGitRefsResponse>;
		loadCommitDiff: (
			scope: RuntimeTrpcProjectScope,
			input: RuntimeGitCommitDiffRequest,
		) => Promise<RuntimeGitCommitDiffResponse>;
		getCommitMessageContext: (
			scope: RuntimeTrpcProjectScope,
			taskScope: { taskId: string; baseRef: string } | null,
			paths?: string[],
		) => Promise<RuntimeCommitMessageGenerationContext>;
		notifyTaskTitleUpdated: (scope: RuntimeTrpcProjectScope, taskId: string, title: string) => void;
		setTaskDisplaySummary: (
			scope: RuntimeTrpcProjectScope,
			taskId: string,
			text: string,
			generatedAt: number | null,
		) => Promise<void>;
		setFocusedTask: (scope: RuntimeTrpcProjectScope, taskId: string | null) => void;
		setDocumentVisible: (scope: RuntimeTrpcProjectScope, clientId: string, isDocumentVisible: boolean) => void;
		stashPush: (
			scope: RuntimeTrpcProjectScope,
			input: { taskScope: { taskId: string; baseRef: string } | null; paths: string[]; message?: string },
		) => Promise<RuntimeStashPushResponse>;
		stashList: (
			scope: RuntimeTrpcProjectScope,
			input: { taskScope: { taskId: string; baseRef: string } | null },
		) => Promise<RuntimeStashListResponse>;
		stashPop: (
			scope: RuntimeTrpcProjectScope,
			input: { taskScope: { taskId: string; baseRef: string } | null; index: number },
		) => Promise<RuntimeStashPopApplyResponse>;
		stashApply: (
			scope: RuntimeTrpcProjectScope,
			input: { taskScope: { taskId: string; baseRef: string } | null; index: number },
		) => Promise<RuntimeStashPopApplyResponse>;
		stashDrop: (
			scope: RuntimeTrpcProjectScope,
			input: { taskScope: { taskId: string; baseRef: string } | null; index: number },
		) => Promise<RuntimeStashDropResponse>;
		stashShow: (
			scope: RuntimeTrpcProjectScope,
			input: { taskScope: { taskId: string; baseRef: string } | null; index: number },
		) => Promise<RuntimeStashShowResponse>;
	};
	projectsApi: {
		listProjects: (preferredProjectId: string | null) => Promise<RuntimeProjectsResponse>;
		addProject: (
			preferredProjectId: string | null,
			input: RuntimeProjectAddRequest,
		) => Promise<RuntimeProjectAddResponse>;
		removeProject: (
			preferredProjectId: string | null,
			input: RuntimeProjectRemoveRequest,
		) => Promise<RuntimeProjectRemoveResponse>;
		pickProjectDirectory: (preferredProjectId: string | null) => Promise<RuntimeProjectDirectoryPickerResponse>;
		reorderProjects: (
			preferredProjectId: string | null,
			input: RuntimeProjectReorderRequest,
		) => Promise<RuntimeProjectReorderResponse>;
	};
	hooksApi: {
		ingest: (input: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>;
	};
}

export interface RuntimeTrpcContextWithProjectScope extends RuntimeTrpcContext {
	projectScope: RuntimeTrpcProjectScope;
}
