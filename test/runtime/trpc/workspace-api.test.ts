import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary, RuntimeWorkspaceChangesResponse } from "../../../src/core/api-contract";

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
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
	mutateWorkspaceState: vi.fn(async () => ({ value: null, state: null, saved: false })),
	saveWorkspaceState: vi.fn(),
	WorkspaceStateConflictError: class extends Error {},
}));

const gitSyncMocks = vi.hoisted(() => ({
	discardGitChanges: vi.fn(),
	getGitSyncSummary: vi.fn(),
	runGitCheckoutAction: vi.fn(),
	runGitSyncAction: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: workspaceTaskWorktreeMocks.deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskWorkspaceInfo: vi.fn(),
	resolveTaskCwd: workspaceTaskWorktreeMocks.resolveTaskCwd,
	getTaskWorkingDirectory: workspaceTaskWorktreeMocks.getTaskWorkingDirectory,
	pathExists: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/workspace/git-sync.js", () => ({
	discardGitChanges: gitSyncMocks.discardGitChanges,
	getGitSyncSummary: gitSyncMocks.getGitSyncSummary,
	runGitCheckoutAction: gitSyncMocks.runGitCheckoutAction,
	runGitSyncAction: gitSyncMocks.runGitSyncAction,
}));

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: workspaceChangesMocks.createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges: workspaceChangesMocks.getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs: workspaceChangesMocks.getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef: workspaceChangesMocks.getWorkspaceChangesFromRef,
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	loadWorkspaceState: workspaceStateMocks.loadWorkspaceState,
	mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
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
}));

vi.mock("../../../src/title/title-generator.js", () => ({
	generateTaskTitle: vi.fn(),
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
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
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
		workspaceTaskWorktreeMocks.getTaskWorkingDirectory.mockReset();
		workspaceStateMocks.loadWorkspaceState.mockReset();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockReset();
		workspaceChangesMocks.getWorkspaceChanges.mockReset();
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockReset();
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockReset();

		// Default: persisted workingDirectory resolves to /tmp/worktree.
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue({ board: { columns: [], dependencies: [] } });
		workspaceTaskWorktreeMocks.getTaskWorkingDirectory.mockReturnValue("/tmp/worktree");
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChanges.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockResolvedValue(createChangesResponse());
	});

	it("shows the completed turn diff while awaiting review", async () => {
		const terminalManager = {
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
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			broadcastTaskTitleUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
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
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			broadcastTaskTitleUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
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
		workspaceTaskWorktreeMocks.getTaskWorkingDirectory.mockReturnValue(null);
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(emptyResponse);

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			broadcastTaskTitleUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
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
});

function createWorkspaceDeps(overrides: Record<string, unknown> = {}) {
	return {
		ensureTerminalManagerForWorkspace: vi.fn(async () => ({}) as never),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastRuntimeProjectsUpdated: vi.fn(),
		broadcastTaskTitleUpdated: vi.fn(),
		buildWorkspaceStateSnapshot: vi.fn(),
		...overrides,
	};
}

const defaultScope = {
	workspaceId: "workspace-1",
	workspacePath: "/tmp/repo",
};

describe("createWorkspaceApi discardGitChanges", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.getTaskWorkingDirectory.mockReset();
		workspaceStateMocks.loadWorkspaceState.mockReset();
		gitSyncMocks.discardGitChanges.mockReset();

		workspaceStateMocks.loadWorkspaceState.mockResolvedValue({ board: { columns: [], dependencies: [] } });
	});

	it("blocks discard when task CWD resolves to the shared workspace path", async () => {
		workspaceTaskWorktreeMocks.getTaskWorkingDirectory.mockReturnValue("/tmp/repo");

		const api = createWorkspaceApi(createWorkspaceDeps());

		const result = await api.discardGitChanges(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/shared checkout/);
		expect(gitSyncMocks.discardGitChanges).not.toHaveBeenCalled();
	});

	it("allows discard when task CWD differs from workspace path", async () => {
		workspaceTaskWorktreeMocks.getTaskWorkingDirectory.mockReturnValue("/tmp/worktree");
		gitSyncMocks.discardGitChanges.mockResolvedValue({
			ok: true,
			summary: {
				currentBranch: "main",
				upstreamBranch: null,
				changedFiles: 0,
				additions: 0,
				deletions: 0,
				aheadCount: 0,
				behindCount: 0,
			},
			output: "",
		});

		const api = createWorkspaceApi(createWorkspaceDeps());

		const result = await api.discardGitChanges(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
		});

		expect(result.ok).toBe(true);
		expect(gitSyncMocks.discardGitChanges).toHaveBeenCalledWith({ cwd: "/tmp/worktree" });
	});
});

describe("createWorkspaceApi checkoutGitBranch", () => {
	beforeEach(() => {
		workspaceStateMocks.loadWorkspaceState.mockReset();
		gitSyncMocks.runGitCheckoutAction.mockReset();

		workspaceStateMocks.loadWorkspaceState.mockResolvedValue({ board: { columns: [], dependencies: [] } });
	});

	it("blocks branch switch when a task uses the shared checkout", async () => {
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue({
			board: {
				columns: [
					{
						id: "in_progress",
						title: "In Progress",
						cards: [
							{
								id: "task-1",
								title: "Test",
								prompt: "x",
								baseRef: "main",
								workingDirectory: "/tmp/repo",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
				dependencies: [],
			},
		});

		const api = createWorkspaceApi(createWorkspaceDeps());

		const result = await api.checkoutGitBranch(defaultScope, { branch: "feature/other" });

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/shared checkout/);
		expect(gitSyncMocks.runGitCheckoutAction).not.toHaveBeenCalled();
	});

	it("allows branch switch when no tasks use the shared checkout", async () => {
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue({
			board: {
				columns: [
					{
						id: "in_progress",
						title: "In Progress",
						cards: [
							{
								id: "task-1",
								title: "Test",
								prompt: "x",
								baseRef: "main",
								workingDirectory: "/tmp/isolated-worktree",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
				dependencies: [],
			},
		});
		gitSyncMocks.runGitCheckoutAction.mockResolvedValue({
			ok: true,
			branch: "feature/other",
			summary: {
				currentBranch: "feature/other",
				upstreamBranch: null,
				changedFiles: 0,
				additions: 0,
				deletions: 0,
				aheadCount: 0,
				behindCount: 0,
			},
			output: "",
		});

		const api = createWorkspaceApi(createWorkspaceDeps());

		const result = await api.checkoutGitBranch(defaultScope, { branch: "feature/other" });

		expect(result.ok).toBe(true);
		expect(gitSyncMocks.runGitCheckoutAction).toHaveBeenCalled();
	});

	it("allows branch switch when shared-checkout task is in backlog or trash", async () => {
		workspaceStateMocks.loadWorkspaceState.mockResolvedValue({
			board: {
				columns: [
					{
						id: "backlog",
						title: "Backlog",
						cards: [
							{
								id: "task-1",
								title: "Test",
								prompt: "x",
								baseRef: "main",
								workingDirectory: "/tmp/repo",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{
						id: "trash",
						title: "Trash",
						cards: [
							{
								id: "task-2",
								title: "Trashed",
								prompt: "y",
								baseRef: "main",
								workingDirectory: "/tmp/repo",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
				dependencies: [],
			},
		});
		gitSyncMocks.runGitCheckoutAction.mockResolvedValue({
			ok: true,
			branch: "feature/other",
			summary: {
				currentBranch: "feature/other",
				upstreamBranch: null,
				changedFiles: 0,
				additions: 0,
				deletions: 0,
				aheadCount: 0,
				behindCount: 0,
			},
			output: "",
		});

		const api = createWorkspaceApi(createWorkspaceDeps());

		const result = await api.checkoutGitBranch(defaultScope, { branch: "feature/other" });

		expect(result.ok).toBe(true);
		expect(gitSyncMocks.runGitCheckoutAction).toHaveBeenCalled();
	});
});

describe("createWorkspaceApi deleteWorktree", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.deleteTaskWorktree.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();

		workspaceStateMocks.mutateWorkspaceState.mockResolvedValue({ value: null, state: null, saved: false });
	});

	it("delegates to deleteTaskWorktree without mutating board state", async () => {
		workspaceTaskWorktreeMocks.deleteTaskWorktree.mockResolvedValue({ ok: true });

		const api = createWorkspaceApi(createWorkspaceDeps());

		const result = await api.deleteWorktree(defaultScope, { taskId: "task-1" });

		expect(result.ok).toBe(true);
		expect(workspaceTaskWorktreeMocks.deleteTaskWorktree).toHaveBeenCalledWith({
			repoPath: "/tmp/repo",
			taskId: "task-1",
		});
		// Board state is NOT mutated server-side — the client clears workingDirectory
		// when it moves the card to trash, avoiding a dual-writer race.
		expect(workspaceStateMocks.mutateWorkspaceState).not.toHaveBeenCalled();
	});

	it("does not clear workingDirectory when delete fails", async () => {
		workspaceTaskWorktreeMocks.deleteTaskWorktree.mockResolvedValue({
			ok: false,
			error: "worktree not found",
		});

		const api = createWorkspaceApi(createWorkspaceDeps());

		const result = await api.deleteWorktree(defaultScope, { taskId: "task-1" });

		expect(result.ok).toBe(false);
		expect(workspaceStateMocks.mutateWorkspaceState).not.toHaveBeenCalled();
	});
});
