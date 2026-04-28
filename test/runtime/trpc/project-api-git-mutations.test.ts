import { beforeEach, describe, expect, it, vi } from "vitest";

const worktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
	resolveTaskWorkingDirectory: vi.fn((): Promise<string> => Promise.resolve("/tmp/worktree")),
	isMissingTaskWorktreeError: vi.fn(
		(error: unknown) => error instanceof Error && error.message.startsWith("Task worktree not found for task "),
	),
	getTaskWorkingDirectory: vi.fn((): string | null => null),
	deleteTaskWorktree: vi.fn(),
}));

const projectStateMocks = vi.hoisted(() => ({
	loadProjectState: vi.fn(),
	saveProjectState: vi.fn(),
	ProjectStateConflictError: class extends Error {},
}));

const gitSyncMocks = vi.hoisted(() => ({
	commitSelectedFiles: vi.fn(),
	discardGitChanges: vi.fn(),
	discardSingleFile: vi.fn(),
	getGitSyncSummary: vi.fn(),
	runGitCheckoutAction: vi.fn(),
	runGitSyncAction: vi.fn(),
}));

vi.mock("../../../src/workdir/task-worktree.js", () => ({
	deleteTaskWorktree: worktreeMocks.deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskWorktreeInfo: vi.fn(),
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
	getGitSyncSummary: gitSyncMocks.getGitSyncSummary,
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
	commitSelectedFiles: gitSyncMocks.commitSelectedFiles,
	createBranchFromRef: vi.fn(),
	deleteBranch: vi.fn(),
	discardGitChanges: gitSyncMocks.discardGitChanges,
	discardSingleFile: gitSyncMocks.discardSingleFile,
	runGitCheckoutAction: gitSyncMocks.runGitCheckoutAction,
	runGitSyncAction: gitSyncMocks.runGitSyncAction,
}));

vi.mock("../../../src/workdir/get-workdir-changes.js", () => ({
	createEmptyWorkdirChangesResponse: vi.fn(),
	getWorkdirChanges: vi.fn(),
	getWorkdirChangesBetweenRefs: vi.fn(),
	getWorkdirChangesFromRef: vi.fn(),
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

function createProjectDeps(overrides: Record<string, unknown> = {}) {
	return {
		terminals: {
			getTerminalManagerForProject: vi.fn(() => null),
			ensureTerminalManagerForProject: vi.fn(async () => ({}) as never),
		},
		broadcaster: {
			broadcastRuntimeProjectStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			broadcastTaskTitleUpdated: vi.fn(),
			setFocusedTask: vi.fn(),
			setDocumentVisible: vi.fn(),
			requestTaskRefresh: vi.fn(),
			requestHomeRefresh: vi.fn(),
		},
		data: { buildProjectStateSnapshot: vi.fn() },
		...overrides,
	};
}

const defaultScope = {
	projectId: "project-1",
	projectPath: "/tmp/repo",
};

describe("createProjectApi discardGitChanges", () => {
	beforeEach(() => {
		worktreeMocks.resolveTaskWorkingDirectory.mockReset();
		projectStateMocks.loadProjectState.mockReset();
		gitSyncMocks.discardGitChanges.mockReset();

		projectStateMocks.loadProjectState.mockResolvedValue({ board: { columns: [], dependencies: [] } });
	});

	it("blocks discard when task CWD resolves to the shared project path", async () => {
		worktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/repo");

		const api = createProjectApi(createProjectDeps());

		const result = await api.discardGitChanges(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/shared checkout/);
		expect(gitSyncMocks.discardGitChanges).not.toHaveBeenCalled();
	});

	it("allows discard when task CWD differs from project path", async () => {
		worktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/worktree");
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

		const api = createProjectApi(createProjectDeps());

		const result = await api.discardGitChanges(defaultScope, {
			taskId: "task-1",
			baseRef: "main",
		});

		expect(result.ok).toBe(true);
		expect(gitSyncMocks.discardGitChanges).toHaveBeenCalledWith({ cwd: "/tmp/worktree" });
	});
});

describe("createProjectApi checkoutGitBranch", () => {
	beforeEach(() => {
		projectStateMocks.loadProjectState.mockReset();
		gitSyncMocks.runGitCheckoutAction.mockReset();

		projectStateMocks.loadProjectState.mockResolvedValue({ board: { columns: [], dependencies: [] } });
	});

	it("blocks branch switch when a task uses the shared checkout", async () => {
		projectStateMocks.loadProjectState.mockResolvedValue({
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

		const api = createProjectApi(createProjectDeps());

		const result = await api.checkoutGitBranch(defaultScope, { branch: "feature/other" });

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/shared checkout/);
		expect(gitSyncMocks.runGitCheckoutAction).not.toHaveBeenCalled();
	});

	it("allows branch switch when no tasks use the shared checkout", async () => {
		projectStateMocks.loadProjectState.mockResolvedValue({
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

		const api = createProjectApi(createProjectDeps());

		const result = await api.checkoutGitBranch(defaultScope, { branch: "feature/other" });

		expect(result.ok).toBe(true);
		expect(gitSyncMocks.runGitCheckoutAction).toHaveBeenCalled();
	});

	it("allows branch switch when shared-checkout task is in backlog or trash", async () => {
		projectStateMocks.loadProjectState.mockResolvedValue({
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

		const api = createProjectApi(createProjectDeps());

		const result = await api.checkoutGitBranch(defaultScope, { branch: "feature/other" });

		expect(result.ok).toBe(true);
		expect(gitSyncMocks.runGitCheckoutAction).toHaveBeenCalled();
	});
});

describe("createProjectApi deleteWorktree", () => {
	beforeEach(() => {
		worktreeMocks.deleteTaskWorktree.mockReset();
	});

	it("delegates to deleteTaskWorktree", async () => {
		worktreeMocks.deleteTaskWorktree.mockResolvedValue({ ok: true });

		const api = createProjectApi(createProjectDeps());

		const result = await api.deleteWorktree(defaultScope, { taskId: "task-1" });

		expect(result.ok).toBe(true);
		expect(worktreeMocks.deleteTaskWorktree).toHaveBeenCalledWith({
			repoPath: "/tmp/repo",
			taskId: "task-1",
		});
	});

	it("returns error when delete fails", async () => {
		worktreeMocks.deleteTaskWorktree.mockResolvedValue({
			ok: false,
			error: "worktree not found",
		});

		const api = createProjectApi(createProjectDeps());

		const result = await api.deleteWorktree(defaultScope, { taskId: "task-1" });

		expect(result.ok).toBe(false);
	});
});

describe("createProjectApi commitSelectedFiles", () => {
	const defaultSummary = {
		currentBranch: "feature/test",
		upstreamBranch: null,
		changedFiles: 0,
		additions: 0,
		deletions: 0,
		aheadCount: 1,
		behindCount: 0,
	};

	beforeEach(() => {
		worktreeMocks.resolveTaskWorkingDirectory.mockReset();
		gitSyncMocks.commitSelectedFiles.mockReset();
	});

	it("resolves home cwd when no taskId", async () => {
		gitSyncMocks.commitSelectedFiles.mockResolvedValue({
			ok: true,
			commitHash: "abc1234",
			summary: defaultSummary,
			output: "",
		});

		const deps = createProjectDeps();
		const api = createProjectApi(deps);

		await api.commitSelectedFiles(defaultScope, {
			taskScope: null,
			paths: ["src/file.ts"],
			message: "test commit",
		});

		expect(gitSyncMocks.commitSelectedFiles).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			paths: ["src/file.ts"],
			message: "test commit",
		});
		expect(worktreeMocks.resolveTaskWorkingDirectory).not.toHaveBeenCalled();
	});

	it("resolves task worktree cwd", async () => {
		worktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/worktree");
		gitSyncMocks.commitSelectedFiles.mockResolvedValue({
			ok: true,
			commitHash: "abc1234",
			summary: defaultSummary,
			output: "",
		});

		const deps = createProjectDeps();
		const api = createProjectApi(deps);

		await api.commitSelectedFiles(defaultScope, {
			taskScope: { taskId: "task-1", baseRef: "main" },
			paths: ["src/file.ts"],
			message: "test commit",
		});

		expect(worktreeMocks.resolveTaskWorkingDirectory).toHaveBeenCalledWith({
			projectPath: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
		});
		expect(gitSyncMocks.commitSelectedFiles).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			paths: ["src/file.ts"],
			message: "test commit",
		});
	});

	it("blocks shared-checkout tasks", async () => {
		worktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/repo");

		const api = createProjectApi(createProjectDeps());

		const result = await api.commitSelectedFiles(defaultScope, {
			taskScope: { taskId: "task-1", baseRef: "main" },
			paths: ["src/file.ts"],
			message: "test commit",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/shared checkout/);
		expect(gitSyncMocks.commitSelectedFiles).not.toHaveBeenCalled();
	});

	it("refreshes home git metadata on success (home-scoped commit)", async () => {
		gitSyncMocks.commitSelectedFiles.mockResolvedValue({
			ok: true,
			commitHash: "abc1234",
			summary: defaultSummary,
			output: "",
		});

		const deps = createProjectDeps();
		const api = createProjectApi(deps);

		await api.commitSelectedFiles(defaultScope, {
			taskScope: null,
			paths: ["src/file.ts"],
			message: "test commit",
		});

		expect(deps.broadcaster.requestHomeRefresh).toHaveBeenCalledWith("project-1");
		expect(deps.broadcaster.broadcastRuntimeProjectStateUpdated).not.toHaveBeenCalled();
	});

	it("returns error on git failure", async () => {
		gitSyncMocks.commitSelectedFiles.mockRejectedValue(new Error("git commit failed"));

		const api = createProjectApi(createProjectDeps());

		const result = await api.commitSelectedFiles(defaultScope, {
			taskScope: null,
			paths: ["src/file.ts"],
			message: "test commit",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toBe("git commit failed");
	});
});

describe("createProjectApi discardFile", () => {
	const defaultSummary = {
		currentBranch: "feature/test",
		upstreamBranch: null,
		changedFiles: 0,
		additions: 0,
		deletions: 0,
		aheadCount: 0,
		behindCount: 0,
	};

	beforeEach(() => {
		worktreeMocks.resolveTaskWorkingDirectory.mockReset();
		gitSyncMocks.discardSingleFile.mockReset();
	});

	it("resolves cwd and calls discardSingleFile", async () => {
		worktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/worktree");
		gitSyncMocks.discardSingleFile.mockResolvedValue({
			ok: true,
			summary: defaultSummary,
			output: "",
		});

		const deps = createProjectDeps();
		const api = createProjectApi(deps);

		const result = await api.discardFile(defaultScope, {
			taskScope: { taskId: "task-1", baseRef: "main" },
			path: "src/file.ts",
			fileStatus: "modified",
		});

		expect(result.ok).toBe(true);
		expect(gitSyncMocks.discardSingleFile).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			path: "src/file.ts",
			fileStatus: "modified",
		});
	});

	it("blocks shared-checkout tasks", async () => {
		worktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/repo");

		const api = createProjectApi(createProjectDeps());

		const result = await api.discardFile(defaultScope, {
			taskScope: { taskId: "task-1", baseRef: "main" },
			path: "src/file.ts",
			fileStatus: "modified",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/shared checkout/);
		expect(gitSyncMocks.discardSingleFile).not.toHaveBeenCalled();
	});

	it("refreshes task git metadata on success (task-scoped discard)", async () => {
		worktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/worktree");
		gitSyncMocks.discardSingleFile.mockResolvedValue({
			ok: true,
			summary: defaultSummary,
			output: "",
		});

		const deps = createProjectDeps();
		const api = createProjectApi(deps);

		await api.discardFile(defaultScope, {
			taskScope: { taskId: "task-1", baseRef: "main" },
			path: "src/file.ts",
			fileStatus: "modified",
		});

		expect(deps.broadcaster.requestTaskRefresh).toHaveBeenCalledWith("project-1", "task-1");
		expect(deps.broadcaster.broadcastRuntimeProjectStateUpdated).not.toHaveBeenCalled();
	});
});
