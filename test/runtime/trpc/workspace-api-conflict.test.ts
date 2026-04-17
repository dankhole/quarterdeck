import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeConflictAbortResponse,
	RuntimeConflictContinueResponse,
	RuntimeConflictFile,
	RuntimeGitMergeResponse,
} from "../../../src/core";

const gitSyncMocks = vi.hoisted(() => ({
	getConflictFileContent: vi.fn(),
	resolveConflictFile: vi.fn(),
	continueMergeOrRebase: vi.fn(),
	abortMergeOrRebase: vi.fn(),
	runGitMergeAction: vi.fn(),
	// Stubs required by the git-sync module mock (used by other workspace-api methods)
	commitSelectedFiles: vi.fn(),
	discardGitChanges: vi.fn(),
	discardSingleFile: vi.fn(),
	getGitSyncSummary: vi.fn(),
	runGitCheckoutAction: vi.fn(),
	runGitSyncAction: vi.fn(),
	createBranchFromRef: vi.fn(),
}));

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskWorkingDirectory: vi.fn((): Promise<string> => Promise.resolve("/tmp/worktree")),
	resolveTaskCwd: vi.fn(),
	isMissingTaskWorktreeError: vi.fn(
		(error: unknown) => error instanceof Error && error.message.startsWith("Task worktree not found for task "),
	),
	getTaskWorkingDirectory: vi.fn((): string | null => null),
	deleteTaskWorktree: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	loadWorkspaceState: vi.fn(),
	saveWorkspaceState: vi.fn(),
	WorkspaceStateConflictError: class extends Error {},
}));

vi.mock("../../../src/workspace/git-cherry-pick.js", () => ({
	cherryPickCommit: vi.fn(),
}));

vi.mock("../../../src/workspace/git-conflict.js", () => ({
	abortMergeOrRebase: gitSyncMocks.abortMergeOrRebase,
	continueMergeOrRebase: gitSyncMocks.continueMergeOrRebase,
	getAutoMergedFileContent: vi.fn(),
	getConflictFileContent: gitSyncMocks.getConflictFileContent,
	resolveConflictFile: gitSyncMocks.resolveConflictFile,
	runGitMergeAction: gitSyncMocks.runGitMergeAction,
}));

vi.mock("../../../src/workspace/git-probe.js", () => ({
	getGitSyncSummary: gitSyncMocks.getGitSyncSummary,
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
	commitSelectedFiles: gitSyncMocks.commitSelectedFiles,
	createBranchFromRef: gitSyncMocks.createBranchFromRef,
	deleteBranch: vi.fn(),
	discardGitChanges: gitSyncMocks.discardGitChanges,
	discardSingleFile: gitSyncMocks.discardSingleFile,
	runGitCheckoutAction: gitSyncMocks.runGitCheckoutAction,
	runGitSyncAction: gitSyncMocks.runGitSyncAction,
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

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
	validateRef: vi.fn(),
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
	getFileContentAtRef: vi.fn(),
	listFilesAtRef: vi.fn(),
}));

vi.mock("../../../src/workspace/read-workspace-file.js", () => ({
	readWorkspaceFile: vi.fn(),
}));

import { createWorkspaceApi } from "../../../src/trpc";

function createWorkspaceDeps(overrides: Record<string, unknown> = {}) {
	return {
		terminals: {
			getTerminalManagerForWorkspace: vi.fn(() => null),
			ensureTerminalManagerForWorkspace: vi.fn(async () => ({}) as never),
		},
		broadcaster: {
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			broadcastTaskTitleUpdated: vi.fn(),
			setFocusedTask: vi.fn(),
			requestTaskRefresh: vi.fn(),
			requestHomeRefresh: vi.fn(),
		},
		data: {
			buildWorkspaceStateSnapshot: vi.fn(),
		},
		...overrides,
	};
}

const defaultScope = {
	workspaceId: "workspace-1",
	workspacePath: "/tmp/repo",
};

const defaultSummary = {
	currentBranch: "main",
	upstreamBranch: null,
	changedFiles: 0,
	additions: 0,
	deletions: 0,
	aheadCount: 0,
	behindCount: 0,
};

describe("createWorkspaceApi conflict resolution", () => {
	beforeEach(() => {
		gitSyncMocks.getConflictFileContent.mockReset();
		gitSyncMocks.resolveConflictFile.mockReset();
		gitSyncMocks.continueMergeOrRebase.mockReset();
		gitSyncMocks.abortMergeOrRebase.mockReset();
		gitSyncMocks.runGitMergeAction.mockReset();
		workspaceStateMocks.loadWorkspaceState.mockReset();

		workspaceStateMocks.loadWorkspaceState.mockResolvedValue({ board: { columns: [], dependencies: [] } });
	});

	it("getConflictFiles returns file content", async () => {
		const file1: RuntimeConflictFile = {
			path: "src/index.ts",
			oursContent: "const x = 1;",
			theirsContent: "const x = 2;",
		};
		const file2: RuntimeConflictFile = {
			path: "src/utils.ts",
			oursContent: "export const a = true;",
			theirsContent: "export const a = false;",
		};
		gitSyncMocks.getConflictFileContent.mockImplementation((_cwd: string, path: string) => {
			if (path === "src/index.ts") return Promise.resolve(file1);
			if (path === "src/utils.ts") return Promise.resolve(file2);
			return Promise.resolve({ path, oursContent: "", theirsContent: "" });
		});

		const api = createWorkspaceApi(createWorkspaceDeps());

		const result = await api.getConflictFiles(defaultScope, {
			paths: ["src/index.ts", "src/utils.ts"],
		});

		expect(result.ok).toBe(true);
		expect(result.files).toHaveLength(2);
		expect(result.files[0]).toEqual(file1);
		expect(result.files[1]).toEqual(file2);
		expect(gitSyncMocks.getConflictFileContent).toHaveBeenCalledTimes(2);
		expect(gitSyncMocks.getConflictFileContent).toHaveBeenCalledWith("/tmp/repo", "src/index.ts");
		expect(gitSyncMocks.getConflictFileContent).toHaveBeenCalledWith("/tmp/repo", "src/utils.ts");
	});

	it("resolveConflictFile calls gitResolveConflictFile", async () => {
		gitSyncMocks.resolveConflictFile.mockResolvedValue({ ok: true });

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.resolveConflictFile(defaultScope, {
			path: "src/index.ts",
			resolution: "ours",
		});

		expect(result.ok).toBe(true);
		expect(gitSyncMocks.resolveConflictFile).toHaveBeenCalledWith("/tmp/repo", "src/index.ts", "ours");
	});

	it("continueConflictResolution calls continueMergeOrRebase", async () => {
		const continueResponse: RuntimeConflictContinueResponse = {
			ok: true,
			completed: true,
			summary: defaultSummary,
			output: "Merge completed successfully.",
		};
		gitSyncMocks.continueMergeOrRebase.mockResolvedValue(continueResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.continueConflictResolution(defaultScope, {});

		expect(result).toEqual(continueResponse);
		expect(gitSyncMocks.continueMergeOrRebase).toHaveBeenCalledWith("/tmp/repo");
	});

	it("abortConflictResolution calls abortMergeOrRebase", async () => {
		const abortResponse: RuntimeConflictAbortResponse = {
			ok: true,
			summary: defaultSummary,
		};
		gitSyncMocks.abortMergeOrRebase.mockResolvedValue(abortResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.abortConflictResolution(defaultScope, {});

		expect(result).toEqual(abortResponse);
		expect(gitSyncMocks.abortMergeOrRebase).toHaveBeenCalledWith("/tmp/repo");
	});

	it("mergeBranch returns conflictState on conflict", async () => {
		const mergeResponse: RuntimeGitMergeResponse = {
			ok: false,
			branch: "feature/other",
			summary: defaultSummary,
			output: "CONFLICT (content): Merge conflict in src/index.ts",
			conflictState: {
				operation: "merge",
				sourceBranch: "feature/other",
				conflictedFiles: ["src/index.ts"],
				autoMergedFiles: [],
				currentStep: null,
				totalSteps: null,
			},
			error: "Merge conflict detected.",
		};
		gitSyncMocks.runGitMergeAction.mockResolvedValue(mergeResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.mergeBranch(defaultScope, { branch: "feature/other" });

		expect(result.ok).toBe(false);
		expect(result.conflictState).toBeDefined();
		expect(result.conflictState?.operation).toBe("merge");
		expect(result.conflictState?.sourceBranch).toBe("feature/other");
		expect(result.conflictState?.conflictedFiles).toEqual(["src/index.ts"]);
		expect(gitSyncMocks.runGitMergeAction).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			branch: "feature/other",
		});
	});

	it("resolveConflictFile broadcasts metadata update", async () => {
		gitSyncMocks.resolveConflictFile.mockResolvedValue({ ok: true });

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		await api.resolveConflictFile(defaultScope, {
			path: "src/index.ts",
			resolution: "theirs",
		});

		expect(deps.broadcaster.broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith("workspace-1", "/tmp/repo");
	});
});
