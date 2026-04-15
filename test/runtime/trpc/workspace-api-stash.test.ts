import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeStashDropResponse,
	RuntimeStashListResponse,
	RuntimeStashPopApplyResponse,
	RuntimeStashPushResponse,
	RuntimeStashShowResponse,
} from "../../../src/core/api-contract";

const gitSyncMocks = vi.hoisted(() => ({
	stashPush: vi.fn(),
	stashList: vi.fn(),
	stashPop: vi.fn(),
	stashApply: vi.fn(),
	stashDrop: vi.fn(),
	stashShow: vi.fn(),
	// Stubs required by the git-sync module mock (used by other workspace-api methods)
	commitSelectedFiles: vi.fn(),
	discardGitChanges: vi.fn(),
	discardSingleFile: vi.fn(),
	getGitSyncSummary: vi.fn(),
	runGitCheckoutAction: vi.fn(),
	runGitSyncAction: vi.fn(),
	runGitMergeAction: vi.fn(),
	getConflictFileContent: vi.fn(),
	resolveConflictFile: vi.fn(),
	continueMergeOrRebase: vi.fn(),
	abortMergeOrRebase: vi.fn(),
	createBranchFromRef: vi.fn(),
	deleteBranch: vi.fn(),
	cherryPickCommit: vi.fn(),
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
	mutateWorkspaceState: vi.fn(async () => ({ value: null, state: null, saved: false })),
	saveWorkspaceState: vi.fn(),
	WorkspaceStateConflictError: class extends Error {},
}));

vi.mock("../../../src/workspace/git-cherry-pick.js", () => ({
	cherryPickCommit: gitSyncMocks.cherryPickCommit,
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
	stashApply: gitSyncMocks.stashApply,
	stashDrop: gitSyncMocks.stashDrop,
	stashList: gitSyncMocks.stashList,
	stashPop: gitSyncMocks.stashPop,
	stashPush: gitSyncMocks.stashPush,
	stashShow: gitSyncMocks.stashShow,
}));

vi.mock("../../../src/workspace/git-sync.js", () => ({
	commitSelectedFiles: gitSyncMocks.commitSelectedFiles,
	createBranchFromRef: gitSyncMocks.createBranchFromRef,
	deleteBranch: gitSyncMocks.deleteBranch,
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

import { createWorkspaceApi } from "../../../src/trpc/workspace-api";

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

describe("createWorkspaceApi stash endpoints", () => {
	beforeEach(() => {
		gitSyncMocks.stashPush.mockReset();
		gitSyncMocks.stashList.mockReset();
		gitSyncMocks.stashPop.mockReset();
		gitSyncMocks.stashApply.mockReset();
		gitSyncMocks.stashDrop.mockReset();
		gitSyncMocks.stashShow.mockReset();
		workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory.mockReset();
		workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory.mockResolvedValue("/tmp/worktree");
	});

	// ─── Test 1: stashPush resolves task CWD and calls stashPush ──────────
	it("stashPush resolves task CWD and calls stashPush", async () => {
		const pushResponse: RuntimeStashPushResponse = { ok: true };
		gitSyncMocks.stashPush.mockResolvedValue(pushResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.stashPush(defaultScope, {
			taskScope: { taskId: "task-1", baseRef: "main" },
			paths: ["src/index.ts"],
			message: "WIP stash",
		});

		expect(result.ok).toBe(true);
		expect(workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory).toHaveBeenCalledWith({
			workspacePath: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
		});
		expect(gitSyncMocks.stashPush).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			paths: ["src/index.ts"],
			message: "WIP stash",
		});
	});

	// ─── Test 1b: stashPush refreshes task git metadata on success ─────────
	it("stashPush refreshes task git metadata on success (task-scoped)", async () => {
		gitSyncMocks.stashPush.mockResolvedValue({ ok: true });

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		await api.stashPush(defaultScope, {
			taskScope: { taskId: "task-1", baseRef: "main" },
			paths: [],
		});

		expect(deps.broadcaster.requestTaskRefresh).toHaveBeenCalledWith("workspace-1", "task-1");
		expect(deps.broadcaster.broadcastRuntimeWorkspaceStateUpdated).not.toHaveBeenCalled();
	});

	// ─── Test 2: stashPush uses home repo for null taskScope ──────────────
	it("stashPush uses home repo for null taskScope", async () => {
		const pushResponse: RuntimeStashPushResponse = { ok: true };
		gitSyncMocks.stashPush.mockResolvedValue(pushResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.stashPush(defaultScope, {
			taskScope: null,
			paths: [],
			message: undefined,
		});

		expect(result.ok).toBe(true);
		expect(workspaceTaskWorktreeMocks.resolveTaskWorkingDirectory).not.toHaveBeenCalled();
		expect(gitSyncMocks.stashPush).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			paths: [],
			message: undefined,
		});
	});

	// ─── Test 3: stashPush refreshes home git metadata on success ─────────
	it("stashPush refreshes home git metadata on success", async () => {
		const pushResponse: RuntimeStashPushResponse = { ok: true };
		gitSyncMocks.stashPush.mockResolvedValue(pushResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		await api.stashPush(defaultScope, {
			taskScope: null,
			paths: [],
		});

		expect(deps.broadcaster.requestHomeRefresh).toHaveBeenCalledWith("workspace-1");
		expect(deps.broadcaster.broadcastRuntimeWorkspaceStateUpdated).not.toHaveBeenCalled();
	});

	// ─── Test 4: stashList returns entries from git-sync ──────────────────
	it("stashList returns entries from git-sync", async () => {
		const listResponse: RuntimeStashListResponse = {
			ok: true,
			entries: [
				{ index: 0, message: "WIP on main", branch: "main", date: "2026-04-12T12:00:00Z" },
				{ index: 1, message: "earlier stash", branch: "main", date: "2026-04-11T12:00:00Z" },
			],
		};
		gitSyncMocks.stashList.mockResolvedValue(listResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.stashList(defaultScope, { taskScope: null });

		expect(result.ok).toBe(true);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].message).toBe("WIP on main");
		expect(gitSyncMocks.stashList).toHaveBeenCalledWith("/tmp/repo");
	});

	// ─── Test 5: stashPop calls stashPop and refreshes metadata ───────────
	it("stashPop calls stashPop and refreshes metadata", async () => {
		const popResponse: RuntimeStashPopApplyResponse = { ok: true, conflicted: false };
		gitSyncMocks.stashPop.mockResolvedValue(popResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.stashPop(defaultScope, {
			taskScope: null,
			index: 0,
		});

		expect(result.ok).toBe(true);
		expect(result.conflicted).toBe(false);
		expect(gitSyncMocks.stashPop).toHaveBeenCalledWith({ cwd: "/tmp/repo", index: 0 });
		expect(deps.broadcaster.requestHomeRefresh).toHaveBeenCalledWith("workspace-1");
	});

	// ─── Test 6: stashApply calls stashApply and refreshes metadata ───────
	it("stashApply calls stashApply and refreshes metadata", async () => {
		const applyResponse: RuntimeStashPopApplyResponse = { ok: true, conflicted: false };
		gitSyncMocks.stashApply.mockResolvedValue(applyResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.stashApply(defaultScope, {
			taskScope: null,
			index: 1,
		});

		expect(result.ok).toBe(true);
		expect(result.conflicted).toBe(false);
		expect(gitSyncMocks.stashApply).toHaveBeenCalledWith({ cwd: "/tmp/repo", index: 1 });
		expect(deps.broadcaster.requestHomeRefresh).toHaveBeenCalledWith("workspace-1");
	});

	// ─── Test 7: stashDrop calls stashDrop and refreshes metadata ─────────
	it("stashDrop calls stashDrop and refreshes metadata", async () => {
		const dropResponse: RuntimeStashDropResponse = { ok: true };
		gitSyncMocks.stashDrop.mockResolvedValue(dropResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.stashDrop(defaultScope, {
			taskScope: null,
			index: 0,
		});

		expect(result.ok).toBe(true);
		expect(gitSyncMocks.stashDrop).toHaveBeenCalledWith({ cwd: "/tmp/repo", index: 0 });
		expect(deps.broadcaster.requestHomeRefresh).toHaveBeenCalledWith("workspace-1");
	});

	// ─── Test 8: stashShow returns diff ───────────────────────────────────
	it("stashShow returns diff", async () => {
		const showResponse: RuntimeStashShowResponse = {
			ok: true,
			diff: "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-original\n+modified",
		};
		gitSyncMocks.stashShow.mockResolvedValue(showResponse);

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);

		const result = await api.stashShow(defaultScope, {
			taskScope: null,
			index: 0,
		});

		expect(result.ok).toBe(true);
		expect(result.diff).toContain("file.txt");
		expect(gitSyncMocks.stashShow).toHaveBeenCalledWith({ cwd: "/tmp/repo", index: 0 });
	});

	// ─── Test 9: stash endpoints handle errors gracefully ─────────────────
	it("stash endpoints handle errors gracefully", async () => {
		gitSyncMocks.stashPush.mockRejectedValue(new Error("git stash push failed"));
		gitSyncMocks.stashList.mockRejectedValue(new Error("git stash list failed"));
		gitSyncMocks.stashPop.mockRejectedValue(new Error("git stash pop failed"));
		gitSyncMocks.stashApply.mockRejectedValue(new Error("git stash apply failed"));
		gitSyncMocks.stashDrop.mockRejectedValue(new Error("git stash drop failed"));
		gitSyncMocks.stashShow.mockRejectedValue(new Error("git stash show failed"));

		const deps = createWorkspaceDeps();
		const api = createWorkspaceApi(deps);
		const nullTaskScope = { taskScope: null };

		const pushResult = await api.stashPush(defaultScope, { ...nullTaskScope, paths: [] });
		expect(pushResult.ok).toBe(false);
		expect(pushResult.error).toBe("git stash push failed");

		const listResult = await api.stashList(defaultScope, nullTaskScope);
		expect(listResult.ok).toBe(false);
		expect(listResult.entries).toEqual([]);
		expect(listResult.error).toBe("git stash list failed");

		const popResult = await api.stashPop(defaultScope, { ...nullTaskScope, index: 0 });
		expect(popResult.ok).toBe(false);
		expect(popResult.error).toBe("git stash pop failed");

		const applyResult = await api.stashApply(defaultScope, { ...nullTaskScope, index: 0 });
		expect(applyResult.ok).toBe(false);
		expect(applyResult.error).toBe("git stash apply failed");

		const dropResult = await api.stashDrop(defaultScope, { ...nullTaskScope, index: 0 });
		expect(dropResult.ok).toBe(false);
		expect(dropResult.error).toBe("git stash drop failed");

		const showResult = await api.stashShow(defaultScope, { ...nullTaskScope, index: 0 });
		expect(showResult.ok).toBe(false);
		expect(showResult.error).toBe("git stash show failed");
	});
});
