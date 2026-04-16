import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary, RuntimeWorkspaceChangesResponse } from "../../../src/core/api-contract";

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
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	loadWorkspaceState: vi.fn(),
	saveWorkspaceState: vi.fn(),
	WorkspaceStateConflictError: class extends Error {},
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: workspaceTaskWorktreeMocks.deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskWorkspaceInfo: vi.fn(),
	resolveTaskCwd: workspaceTaskWorktreeMocks.resolveTaskCwd,
	resolveTaskWorkingDirectory: workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory,
	isMissingTaskWorktreeError: workspaceTaskWorktreeMocks.isMissingTaskWorktreeError,
	getTaskWorkingDirectory: workspaceTaskWorktreeMocks.getTaskWorkingDirectory,
	pathExists: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/workspace/git-cherry-pick.js", () => ({
	cherryPickCommit: vi.fn(),
}));

vi.mock("../../../src/workspace/git-conflict.js", () => ({
	abortMergeOrRebase: vi.fn(),
	continueMergeOrRebase: vi.fn(),
	getAutoMergedFileContent: vi.fn(),
	getConflictFileContent: vi.fn(),
	resolveConflictFile: vi.fn(),
	runGitMergeAction: vi.fn(),
}));

vi.mock("../../../src/workspace/git-probe.js", () => ({
	getGitSyncSummary: vi.fn(),
}));

vi.mock("../../../src/workspace/git-stash.js", () => ({
	stashApply: vi.fn(),
	stashDrop: vi.fn(),
	stashList: vi.fn(),
	stashPop: vi.fn(),
	stashPush: vi.fn(),
	stashShow: vi.fn(),
}));

vi.mock("../../../src/workspace/git-sync.js", () => ({
	commitSelectedFiles: vi.fn(),
	createBranchFromRef: vi.fn(),
	deleteBranch: vi.fn(),
	discardGitChanges: vi.fn(),
	discardSingleFile: vi.fn(),
	runGitCheckoutAction: vi.fn(),
	runGitSyncAction: vi.fn(),
}));

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: workspaceChangesMocks.createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges: workspaceChangesMocks.getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs: workspaceChangesMocks.getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef: workspaceChangesMocks.getWorkspaceChangesFromRef,
	getWorkspaceFileDiff: vi.fn(),
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	loadWorkspaceState: workspaceStateMocks.loadWorkspaceState,
	saveWorkspaceState: workspaceStateMocks.saveWorkspaceState,
	WorkspaceStateConflictError: workspaceStateMocks.WorkspaceStateConflictError,
}));

vi.mock("../../../src/core/task-board-mutations.js", () => ({
	findCardInBoard: vi.fn(),
}));

vi.mock("../../../src/workspace/git-history.js", () => ({
	getCommitDiff: vi.fn(),
	getGitLog: vi.fn(),
	getGitRefs: vi.fn(),
}));

vi.mock("../../../src/workspace/search-workspace-files.js", () => ({
	searchWorkspaceFiles: vi.fn(),
	listAllWorkspaceFiles: vi.fn(),
}));

vi.mock("../../../src/title/title-generator.js", () => ({
	generateTaskTitle: vi.fn(),
	generateBranchName: vi.fn(),
}));

vi.mock("../../../src/workspace/git-utils.js", () => ({
	assertValidGitRef: vi.fn(),
	validateGitPath: vi.fn(() => true),
	getFileContentAtRef: vi.fn(),
	getGitStdout: vi.fn(),
	listFilesAtRef: vi.fn(),
}));

vi.mock("../../../src/workspace/read-workspace-file.js", () => ({
	readWorkspaceFile: vi.fn(),
}));

import { createWorkspaceApi } from "../../../src/trpc/workspace-api";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
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

function createChangesResponse(): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: "/tmp/worktree",
		generatedAt: Date.now(),
		files: [],
	};
}

describe("createWorkspaceApi loadChanges", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockReset();
		workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory.mockReset();
		workspaceStateMocks.loadWorkspaceState.mockReset();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockReset();
		workspaceChangesMocks.getWorkspaceChanges.mockReset();
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockReset();
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockReset();

		// Default: resolveTaskWorkingDirectory resolves to /tmp/worktree.
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue({ board: { columns: [], dependencies: [] } });
		workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChanges.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockResolvedValue(createChangesResponse());
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

		const api = createWorkspaceApi({
			terminals: {
				getTerminalManagerForWorkspace: vi.fn(() => null),
				ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			},
			broadcaster: {
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildWorkspaceStateSnapshot: vi.fn() },
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "1111111",
			toRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
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

		const api = createWorkspaceApi({
			terminals: {
				getTerminalManagerForWorkspace: vi.fn(() => null),
				ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			},
			broadcaster: {
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildWorkspaceStateSnapshot: vi.fn() },
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("returns an empty diff when the task worktree does not exist yet", async () => {
		// No persisted workingDirectory, and worktree doesn't exist on disk.
		workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(emptyResponse);

		const api = createWorkspaceApi({
			terminals: {
				getTerminalManagerForWorkspace: vi.fn(() => null),
				ensureTerminalManagerForWorkspace: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildWorkspaceStateSnapshot: vi.fn() },
		});

		const response = await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.createEmptyWorkspaceChangesResponse).toHaveBeenCalledWith("/tmp/repo");
		expect(workspaceChangesMocks.getWorkspaceChanges).not.toHaveBeenCalled();
	});

	it("diffs fromRef against working tree when toRef is omitted (task-scoped)", async () => {
		const api = createWorkspaceApi({
			terminals: {
				getTerminalManagerForWorkspace: vi.fn(() => null),
				ensureTerminalManagerForWorkspace: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildWorkspaceStateSnapshot: vi.fn() },
		});

		await api.loadChanges(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", fromRef: "main", mode: "working_copy" },
		);

		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "main",
			threeDot: false,
		});
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("diffs fromRef against working tree when toRef is omitted (home repo)", async () => {
		const api = createWorkspaceApi({
			terminals: {
				getTerminalManagerForWorkspace: vi.fn(() => null),
				ensureTerminalManagerForWorkspace: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildWorkspaceStateSnapshot: vi.fn() },
		});

		await api.loadChanges(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: null, fromRef: "main", mode: "working_copy" },
		);

		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			fromRef: "main",
			threeDot: false,
		});
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("returns empty diff for fromRef-only when task worktree is missing", async () => {
		workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);
		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(emptyResponse);

		const api = createWorkspaceApi({
			terminals: {
				getTerminalManagerForWorkspace: vi.fn(() => null),
				ensureTerminalManagerForWorkspace: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildWorkspaceStateSnapshot: vi.fn() },
		});

		const response = await api.loadChanges(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", fromRef: "main", mode: "working_copy" },
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
	});
});
