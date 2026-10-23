import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkdirChangesResponse } from "../../../src/core";
import type * as DirectoryListing from "../../../src/workdir/workdir-directory-listing";

const worktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
	resolveTaskWorkingDirectory: vi.fn((): Promise<string> => Promise.resolve("/tmp/worktree")),
	isMissingTaskWorktreeError: vi.fn(
		(error: unknown) => error instanceof Error && error.message.startsWith("Task worktree not found for task "),
	),
	getTaskWorkingDirectory: vi.fn((): string | null => null),
	deleteTaskWorktree: vi.fn(),
}));

const workdirChangesMocks = vi.hoisted(() => ({
	createEmptyWorkdirChangesResponse: vi.fn(),
	getWorkdirChanges: vi.fn(),
	getWorkdirChangesBetweenRefs: vi.fn(),
	getWorkdirChangesFromRef: vi.fn(),
}));

const listingMocks = vi.hoisted(() => ({
	listPage: vi.fn(),
	searchFolder: vi.fn(),
	searchFilePaths: vi.fn(),
	searchWorkdirFiles: vi.fn(),
}));

const fileMutationMocks = vi.hoisted(() => ({
	createWorkdirEntry: vi.fn(),
	deleteWorkdirEntry: vi.fn(),
	readWorkdirFile: vi.fn(),
	renameWorkdirEntry: vi.fn(),
	saveWorkdirFile: vi.fn(),
	WorkdirFileConflictError: class extends Error {},
}));

const projectStateMocks = vi.hoisted(() => ({
	loadProjectState: vi.fn(),
	loadProjectScopeById: vi.fn().mockResolvedValue(null),
	saveProjectState: vi.fn(),
	ProjectStateConflictError: class extends Error {},
}));

vi.mock("../../../src/workdir/task-worktree.js", () => ({
	deleteTaskWorktree: worktreeMocks.deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskRepositoryInfo: vi.fn(),
	resolveTaskCwd: worktreeMocks.resolveTaskCwd,
	resolveTaskWorkingDirectory: worktreeMocks.resolveTaskWorkingDirectory,
	isMissingTaskWorktreeError: worktreeMocks.isMissingTaskWorktreeError,
	getTaskWorkingDirectory: worktreeMocks.getTaskWorkingDirectory,
	pathExists: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/workdir/git-cherry-pick.js", () => ({
	cherryPickCommit: vi.fn(),
}));

vi.mock("../../../src/workdir/git-conflict.js", () => ({
	abortMergeOrRebase: vi.fn(),
	continueMergeOrRebase: vi.fn(),
	getAutoMergedFileContent: vi.fn(),
	getConflictFileContent: vi.fn(),
	resolveConflictFile: vi.fn(),
	runGitMergeAction: vi.fn(),
}));

vi.mock("../../../src/workdir/git-probe.js", () => ({
	getGitSyncSummary: vi.fn(),
}));

vi.mock("../../../src/workdir/git-stash.js", () => ({
	stashApply: vi.fn(),
	stashDrop: vi.fn(),
	stashList: vi.fn(),
	stashPop: vi.fn(),
	stashPush: vi.fn(),
	stashShow: vi.fn(),
}));

vi.mock("../../../src/workdir/git-sync.js", () => ({
	commitSelectedFiles: vi.fn(),
	createBranchFromRef: vi.fn(),
	deleteBranch: vi.fn(),
	discardGitChanges: vi.fn(),
	discardSingleFile: vi.fn(),
	runGitCheckoutAction: vi.fn(),
	runGitSyncAction: vi.fn(),
}));

vi.mock("../../../src/workdir/get-workdir-changes.js", () => ({
	createEmptyWorkdirChangesResponse: workdirChangesMocks.createEmptyWorkdirChangesResponse,
	getWorkdirChanges: workdirChangesMocks.getWorkdirChanges,
	getWorkdirChangesBetweenRefs: workdirChangesMocks.getWorkdirChangesBetweenRefs,
	getWorkdirChangesFromRef: workdirChangesMocks.getWorkdirChangesFromRef,
	getWorkdirFileDiff: vi.fn(),
}));

vi.mock("../../../src/state/project-state.js", () => ({
	loadProjectState: projectStateMocks.loadProjectState,
	loadProjectScopeById: projectStateMocks.loadProjectScopeById,
	saveProjectState: projectStateMocks.saveProjectState,
	ProjectStateConflictError: projectStateMocks.ProjectStateConflictError,
}));

vi.mock("../../../src/core/task-board-mutations.js", () => ({
	findCardInBoard: vi.fn(),
}));

vi.mock("../../../src/workdir/git-history.js", () => ({
	getCommitDiff: vi.fn(),
	getGitLog: vi.fn(),
	getGitRefs: vi.fn(),
}));

vi.mock("../../../src/workdir/search-workdir-files.js", () => ({
	invalidateWorkdirFileListCache: vi.fn(),
	searchWorkdirFiles: listingMocks.searchWorkdirFiles,
	searchFilePaths: listingMocks.searchFilePaths,
}));

vi.mock("../../../src/workdir/search-workdir-folder-files.js", () => ({
	searchFolderWorkdirFiles: listingMocks.searchFolder,
}));

vi.mock("../../../src/workdir/workdir-directory-listing.js", async (importOriginal) => ({
	...(await importOriginal<typeof DirectoryListing>()),
	listWorkdirDirectoryPage: listingMocks.listPage,
}));

vi.mock("../../../src/title/title-generator.js", () => ({
	generateTaskTitle: vi.fn(),
	generateBranchName: vi.fn(),
}));

vi.mock("../../../src/workdir/git-utils.js", () => ({
	assertValidGitRef: vi.fn(),
	validateGitPath: vi.fn(() => true),
	getFileContentAtRef: vi.fn(),
	getGitStdout: vi.fn(),
	listFilesAtRef: vi.fn(),
}));

vi.mock("../../../src/workdir/read-workdir-file.js", () => ({
	readWorkdirFile: fileMutationMocks.readWorkdirFile,
	readWorkdirFileExcerpt: vi.fn(),
}));

vi.mock("../../../src/workdir/save-workdir-file.js", () => ({
	saveWorkdirFile: fileMutationMocks.saveWorkdirFile,
	WorkdirFileConflictError: fileMutationMocks.WorkdirFileConflictError,
}));

vi.mock("../../../src/workdir/mutate-workdir-entry.js", () => ({
	createWorkdirEntry: fileMutationMocks.createWorkdirEntry,
	renameWorkdirEntry: fileMutationMocks.renameWorkdirEntry,
	deleteWorkdirEntry: fileMutationMocks.deleteWorkdirEntry,
}));

import { TaskResourceOperationCoordinator } from "../../../src/core";
import { createProjectApi } from "../../../src/trpc";
import { WorkdirDirectoryListingError } from "../../../src/workdir/workdir-directory-listing";

function createChangesResponse(): RuntimeWorkdirChangesResponse {
	return {
		repoRoot: "/tmp/worktree",
		generatedAt: Date.now(),
		files: [],
	};
}

function createProjectDeps() {
	return {
		terminals: {
			getTerminalManagerForProject: vi.fn(() => null),
			ensureTerminalManagerForProject: vi.fn(async () => ({}) as never),
		},
		broadcaster: {
			broadcastRuntimeProjectStateUpdated: vi.fn(),
			broadcastRuntimeProjectNotificationsUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			broadcastTaskTitleUpdated: vi.fn(),
			setFocusedTask: vi.fn(),
			setDocumentVisible: vi.fn(),
			requestTaskRefresh: vi.fn(),
			requestHomeRefresh: vi.fn(),
		},
		data: { buildProjectStateSnapshot: vi.fn() },
		taskResourceOperations: new TaskResourceOperationCoordinator(),
	};
}

describe("createProjectApi file content mutations", () => {
	beforeEach(() => {
		worktreeMocks.resolveTaskWorkingDirectory.mockReset();
		fileMutationMocks.saveWorkdirFile.mockReset();
		fileMutationMocks.createWorkdirEntry.mockReset();
		fileMutationMocks.readWorkdirFile.mockReset();

		worktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/repo");
		fileMutationMocks.saveWorkdirFile.mockResolvedValue({
			content: "updated\n",
			language: "typescript",
			binary: false,
			size: 8,
			truncated: false,
			contentHash: "hash-saved",
			editable: true,
		});
		fileMutationMocks.createWorkdirEntry.mockResolvedValue({ ok: true, path: "src/new.ts", kind: "file" });
		fileMutationMocks.readWorkdirFile.mockResolvedValue({
			content: "content\n",
			language: "text",
			binary: false,
			size: 8,
			truncated: false,
		});
	});

	it("refreshes task and home git metadata after saving a shared-checkout task file", async () => {
		const deps = createProjectDeps();
		const api = createProjectApi(deps);

		await api.saveFileContent(
			{ projectId: "project-1", projectPath: "/tmp/repo" },
			{
				taskId: "task-1",
				baseRef: "main",
				path: "src/app.ts",
				content: "updated\n",
				expectedContentHash: "hash-before",
			},
		);

		expect(fileMutationMocks.saveWorkdirFile).toHaveBeenCalledWith(
			"/tmp/repo",
			"src/app.ts",
			"updated\n",
			"hash-before",
		);
		expect(deps.broadcaster.requestTaskRefresh).toHaveBeenCalledWith("project-1", "task-1");
		expect(deps.broadcaster.requestHomeRefresh).toHaveBeenCalledWith("project-1");
	});

	it("refreshes home git metadata after creating a home file", async () => {
		const deps = createProjectDeps();
		const api = createProjectApi(deps);

		await api.createWorkdirEntry(
			{ projectId: "project-1", projectPath: "/tmp/repo" },
			{ taskId: null, path: "src/new.ts", kind: "file" },
		);

		expect(fileMutationMocks.createWorkdirEntry).toHaveBeenCalledWith("/tmp/repo", "src/new.ts", "file");
		expect(deps.broadcaster.requestTaskRefresh).not.toHaveBeenCalled();
		expect(deps.broadcaster.requestHomeRefresh).toHaveBeenCalledWith("project-1");
	});

	it("preserves leading spaces in existing file paths", async () => {
		const deps = createProjectDeps();
		const api = createProjectApi(deps);

		await api.getFileContent(
			{ projectId: "project-1", projectPath: "/tmp/repo" },
			{ taskId: null, path: " leading.txt" },
		);
		await api.saveFileContent(
			{ projectId: "project-1", projectPath: "/tmp/repo" },
			{
				taskId: null,
				path: " leading.txt",
				content: "updated\n",
				expectedContentHash: "hash-before",
			},
		);

		expect(fileMutationMocks.readWorkdirFile).toHaveBeenCalledWith("/tmp/repo", " leading.txt");
		expect(fileMutationMocks.saveWorkdirFile).toHaveBeenCalledWith(
			"/tmp/repo",
			" leading.txt",
			"updated\n",
			"hash-before",
		);
	});
});

describe("createProjectApi loadChanges", () => {
	beforeEach(() => {
		worktreeMocks.resolveTaskCwd.mockReset();
		worktreeMocks.resolveTaskWorkingDirectory.mockReset();
		projectStateMocks.loadProjectState.mockReset();
		workdirChangesMocks.createEmptyWorkdirChangesResponse.mockReset();
		workdirChangesMocks.getWorkdirChanges.mockReset();
		workdirChangesMocks.getWorkdirChangesBetweenRefs.mockReset();
		workdirChangesMocks.getWorkdirChangesFromRef.mockReset();

		// Default: resolveTaskWorkingDirectory resolves to /tmp/worktree.
		projectStateMocks.loadProjectState.mockResolvedValue({ board: { columns: [] } });
		worktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/worktree");
		workdirChangesMocks.createEmptyWorkdirChangesResponse.mockResolvedValue(createChangesResponse());
		workdirChangesMocks.getWorkdirChanges.mockResolvedValue(createChangesResponse());
		workdirChangesMocks.getWorkdirChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workdirChangesMocks.getWorkdirChangesFromRef.mockResolvedValue(createChangesResponse());
	});

	it("returns an empty diff when the task worktree does not exist yet", async () => {
		// No persisted workingDirectory, and worktree doesn't exist on disk.
		worktreeMocks.resolveTaskWorkingDirectory.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workdirChangesMocks.createEmptyWorkdirChangesResponse.mockResolvedValue(emptyResponse);

		const api = createProjectApi({
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectNotificationsUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				setDocumentVisible: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot: vi.fn() },
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		const response = await api.loadChanges(
			{
				projectId: "project-1",
				projectPath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(response).toBe(emptyResponse);
		expect(workdirChangesMocks.createEmptyWorkdirChangesResponse).toHaveBeenCalledWith("/tmp/repo");
		expect(workdirChangesMocks.getWorkdirChanges).not.toHaveBeenCalled();
	});

	it("diffs fromRef against working tree when toRef is omitted (task-scoped)", async () => {
		const api = createProjectApi({
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectNotificationsUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				setDocumentVisible: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot: vi.fn() },
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await api.loadChanges(
			{ projectId: "project-1", projectPath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", fromRef: "main", mode: "working_copy" },
		);

		expect(workdirChangesMocks.getWorkdirChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "main",
			threeDot: false,
		});
		expect(workdirChangesMocks.getWorkdirChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("diffs fromRef against working tree when toRef is omitted (home repo)", async () => {
		const api = createProjectApi({
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectNotificationsUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				setDocumentVisible: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot: vi.fn() },
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await api.loadChanges(
			{ projectId: "project-1", projectPath: "/tmp/repo" },
			{ taskId: null, fromRef: "main", mode: "working_copy" },
		);

		expect(workdirChangesMocks.getWorkdirChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			fromRef: "main",
			threeDot: false,
		});
		expect(workdirChangesMocks.getWorkdirChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("returns empty diff for fromRef-only when task worktree is missing", async () => {
		worktreeMocks.resolveTaskWorkingDirectory.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);
		const emptyResponse = createChangesResponse();
		workdirChangesMocks.createEmptyWorkdirChangesResponse.mockResolvedValue(emptyResponse);

		const api = createProjectApi({
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectNotificationsUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				setDocumentVisible: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot: vi.fn() },
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		const response = await api.loadChanges(
			{ projectId: "project-1", projectPath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", fromRef: "main", mode: "working_copy" },
		);

		expect(response).toBe(emptyResponse);
		expect(workdirChangesMocks.getWorkdirChangesFromRef).not.toHaveBeenCalled();
	});
});

describe("createProjectApi paged file listing", () => {
	const projectScope = { projectId: "project-1", projectPath: "/tmp/repo" };
	const page = {
		directory: "src",
		files: ["src/a.ts"],
		directories: ["src/lib"],
		hiddenCount: 1,
		snapshotId: "snapshot",
		nextCursor: "cursor",
	};

	beforeEach(() => {
		projectStateMocks.loadProjectScopeById.mockReset();
		listingMocks.listPage.mockReset().mockResolvedValue(page);
		listingMocks.searchFolder.mockReset().mockResolvedValue({ files: [], truncated: true });
		listingMocks.searchFilePaths.mockReset().mockReturnValue([]);
		listingMocks.searchWorkdirFiles.mockReset().mockResolvedValue([]);
	});

	it.each([true, false])("lists one directory page with folderOnly=%s and scope mutability", async (folderOnly) => {
		projectStateMocks.loadProjectScopeById.mockResolvedValue({ folderOnly });
		const api = createProjectApi(createProjectDeps());
		const response = await api.listFiles(projectScope, {
			taskId: null,
			directory: "src",
			cursor: "cursor-in",
			showExcluded: true,
		});
		expect(listingMocks.listPage).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			directory: "src",
			cursor: "cursor-in",
			showExcluded: true,
			useGitIgnores: !folderOnly,
			ref: null,
		});
		expect(response).toEqual({ ...page, mutable: true });
		expect(projectStateMocks.loadProjectScopeById).toHaveBeenCalledWith("project-1");
	});

	it("defaults to hiding generated worktrees", async () => {
		const api = createProjectApi(createProjectDeps());
		await api.listFiles(projectScope, { taskId: null });
		expect(listingMocks.listPage).toHaveBeenCalledWith(
			expect.objectContaining({ directory: undefined, cursor: undefined, showExcluded: false }),
		);
	});

	it.each([
		["invalid_directory", "BAD_REQUEST"],
		["invalid_cursor", "BAD_REQUEST"],
		["blocked_directory", "FORBIDDEN"],
		["excluded_directory", "FORBIDDEN"],
		["not_found", "NOT_FOUND"],
		["busy", "TOO_MANY_REQUESTS"],
	] as const)("maps %s listing errors to %s", async (code, trpcCode) => {
		listingMocks.listPage.mockRejectedValue(new WorkdirDirectoryListingError(code, `listing ${code}`));
		const api = createProjectApi(createProjectDeps());
		await expect(api.listFiles(projectScope, { taskId: null })).rejects.toMatchObject({
			code: trpcCode,
			message: `listing ${code}`,
		});
	});

	it("returns the unavailable page shape when the task worktree is missing", async () => {
		worktreeMocks.resolveTaskWorkingDirectory.mockRejectedValueOnce(
			new Error("Task worktree not found for task task-1"),
		);
		const api = createProjectApi(createProjectDeps());
		expect(await api.listFiles(projectScope, { taskId: "task-1", directory: "src" })).toEqual({
			directory: "src",
			files: [],
			directories: [],
			mutable: false,
			mutationBlockedReason: "Worktree is unavailable.",
			snapshotId: null,
			nextCursor: null,
			hiddenCount: 0,
		});
		expect(listingMocks.listPage).not.toHaveBeenCalled();
	});

	it("uses the bounded folder scan for folder quick-open and reports truncation", async () => {
		projectStateMocks.loadProjectScopeById.mockResolvedValue({ folderOnly: true });
		const api = createProjectApi(createProjectDeps());
		expect(await api.searchFiles(projectScope, { query: " file " })).toEqual({
			query: "file",
			files: [],
			truncated: true,
		});
		expect(listingMocks.searchFolder).toHaveBeenCalledWith("/tmp/repo", "file", undefined);
		expect(listingMocks.searchWorkdirFiles).not.toHaveBeenCalled();
	});

	it("keeps Git quick-open on the dedicated index without a truncation claim", async () => {
		projectStateMocks.loadProjectScopeById.mockResolvedValue({ folderOnly: false });
		const api = createProjectApi(createProjectDeps());
		expect(await api.searchFiles(projectScope, { query: "file", limit: 5 })).toEqual({ query: "file", files: [] });
		expect(listingMocks.searchWorkdirFiles).toHaveBeenCalledWith("/tmp/repo", "file", 5);
		expect(listingMocks.searchFolder).not.toHaveBeenCalled();
	});
});
