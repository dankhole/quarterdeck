import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary, RuntimeWorkdirChangesResponse } from "../../../src/core";

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
	resolveTaskWorkingDirectory: vi.fn((): Promise<string> => Promise.resolve("/tmp/worktree")),
	isMissingTaskWorktreeError: vi.fn(
		(error: unknown) => error instanceof Error && error.message.startsWith("Task worktree not found for task "),
	),
	getTaskWorkingDirectory: vi.fn((): string | null => null),
	deleteTaskWorktree: vi.fn(),
}));

const workspaceChangesMocks = vi.hoisted(() => ({
	createEmptyWorkdirChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkdirChangesBetweenRefs: vi.fn(),
	getWorkdirChangesFromRef: vi.fn(),
}));

const projectStateMocks = vi.hoisted(() => ({
	loadProjectState: vi.fn(),
	saveProjectState: vi.fn(),
	ProjectStateConflictError: class extends Error {},
}));

vi.mock("../../../src/workdir/task-worktree.js", () => ({
	deleteTaskWorktree: workspaceTaskWorktreeMocks.deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskWorktreeInfo: vi.fn(),
	resolveTaskCwd: workspaceTaskWorktreeMocks.resolveTaskCwd,
	resolveTaskWorkingDirectory: workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory,
	isMissingTaskWorktreeError: workspaceTaskWorktreeMocks.isMissingTaskWorktreeError,
	getTaskWorkingDirectory: workspaceTaskWorktreeMocks.getTaskWorkingDirectory,
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
	createEmptyWorkdirChangesResponse: workspaceChangesMocks.createEmptyWorkdirChangesResponse,
	getWorkspaceChanges: workspaceChangesMocks.getWorkspaceChanges,
	getWorkdirChangesBetweenRefs: workspaceChangesMocks.getWorkdirChangesBetweenRefs,
	getWorkdirChangesFromRef: workspaceChangesMocks.getWorkdirChangesFromRef,
	getWorkdirFileDiff: vi.fn(),
}));

vi.mock("../../../src/state/project-state.js", () => ({
	loadProjectState: projectStateMocks.loadProjectState,
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
	searchWorkdirFiles: vi.fn(),
	listAllWorkdirFiles: vi.fn(),
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
	readWorkdirFile: vi.fn(),
}));

import { createProjectApi } from "../../../src/trpc";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		projectPath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

function createChangesResponse(): RuntimeWorkdirChangesResponse {
	return {
		repoRoot: "/tmp/worktree",
		generatedAt: Date.now(),
		files: [],
	};
}

describe("createProjectApi loadChanges", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockReset();
		workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory.mockReset();
		projectStateMocks.loadProjectState.mockReset();
		workspaceChangesMocks.createEmptyWorkdirChangesResponse.mockReset();
		workspaceChangesMocks.getWorkspaceChanges.mockReset();
		workspaceChangesMocks.getWorkdirChangesBetweenRefs.mockReset();
		workspaceChangesMocks.getWorkdirChangesFromRef.mockReset();

		// Default: resolveTaskWorkingDirectory resolves to /tmp/worktree.
		projectStateMocks.loadProjectState.mockResolvedValue({ board: { columns: [], dependencies: [] } });
		workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.createEmptyWorkdirChangesResponse.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChanges.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkdirChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkdirChangesFromRef.mockResolvedValue(createChangesResponse());
	});

	it("shows the completed turn diff while awaiting review", async () => {
		const terminalManager = {
			store: {
				getSummary: vi.fn(() =>
					createSummary({
						state: "awaiting_review",
						latestTurnCheckpoint: {
							turn: 2,
							ref: "refs/quarterdeck/checkpoints/task-1/turn/2",
							commit: "2222222",
							createdAt: 2,
						},
						previousTurnCheckpoint: {
							turn: 1,
							ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
							commit: "1111111",
							createdAt: 1,
						},
					}),
				),
			},
		};

		const api = createProjectApi({
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(async () => terminalManager as never),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot: vi.fn() },
		});

		await api.loadChanges(
			{
				projectId: "workspace-1",
				projectPath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkdirChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "1111111",
			toRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkdirChangesFromRef).not.toHaveBeenCalled();
	});

	it("tracks the current turn from the latest checkpoint while running", async () => {
		const terminalManager = {
			store: {
				getSummary: vi.fn(() =>
					createSummary({
						state: "running",
						latestTurnCheckpoint: {
							turn: 2,
							ref: "refs/quarterdeck/checkpoints/task-1/turn/2",
							commit: "2222222",
							createdAt: 2,
						},
						previousTurnCheckpoint: {
							turn: 1,
							ref: "refs/quarterdeck/checkpoints/task-1/turn/1",
							commit: "1111111",
							createdAt: 1,
						},
					}),
				),
			},
		};

		const api = createProjectApi({
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(async () => terminalManager as never),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot: vi.fn() },
		});

		await api.loadChanges(
			{
				projectId: "workspace-1",
				projectPath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkdirChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkdirChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("returns an empty diff when the task worktree does not exist yet", async () => {
		// No persisted workingDirectory, and worktree doesn't exist on disk.
		workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkdirChangesResponse.mockResolvedValue(emptyResponse);

		const api = createProjectApi({
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot: vi.fn() },
		});

		const response = await api.loadChanges(
			{
				projectId: "workspace-1",
				projectPath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.createEmptyWorkdirChangesResponse).toHaveBeenCalledWith("/tmp/repo");
		expect(workspaceChangesMocks.getWorkspaceChanges).not.toHaveBeenCalled();
	});

	it("diffs fromRef against working tree when toRef is omitted (task-scoped)", async () => {
		const api = createProjectApi({
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot: vi.fn() },
		});

		await api.loadChanges(
			{ projectId: "workspace-1", projectPath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", fromRef: "main", mode: "working_copy" },
		);

		expect(workspaceChangesMocks.getWorkdirChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "main",
			threeDot: false,
		});
		expect(workspaceChangesMocks.getWorkdirChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("diffs fromRef against working tree when toRef is omitted (home repo)", async () => {
		const api = createProjectApi({
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot: vi.fn() },
		});

		await api.loadChanges(
			{ projectId: "workspace-1", projectPath: "/tmp/repo" },
			{ taskId: null, fromRef: "main", mode: "working_copy" },
		);

		expect(workspaceChangesMocks.getWorkdirChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			fromRef: "main",
			threeDot: false,
		});
		expect(workspaceChangesMocks.getWorkdirChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("returns empty diff for fromRef-only when task worktree is missing", async () => {
		workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);
		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkdirChangesResponse.mockResolvedValue(emptyResponse);

		const api = createProjectApi({
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot: vi.fn() },
		});

		const response = await api.loadChanges(
			{ projectId: "workspace-1", projectPath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", fromRef: "main", mode: "working_copy" },
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.getWorkdirChangesFromRef).not.toHaveBeenCalled();
	});
});
