import { describe, expect, it } from "vitest";

import { resolveTaskGitState } from "@/utils/task-git-state";

describe("resolveTaskGitState", () => {
	it("falls back to home git metadata for explicitly shared tasks without assigned metadata", () => {
		const state = resolveTaskGitState({
			projectRootPath: "/repo",
			card: {
				branch: null,
				useWorktree: false,
				workingDirectory: null,
			},
			repositoryInfo: {
				taskId: "task-1",
				path: "/repo/.quarterdeck/worktrees/task-1",
				exists: false,
				baseRef: "main",
				branch: null,
				isDetached: false,
				headCommit: null,
			},
			homeGitSummary: {
				currentBranch: "main",
				upstreamBranch: "origin/main",
				changedFiles: 2,
				additions: 5,
				deletions: 1,
				aheadCount: 0,
				behindCount: 0,
			},
		});

		expect(state.identity.assignedPath).toBe("/repo");
		expect(state.branch).toBe("main");
		expect(state.branchLabel).toBe("main");
		expect(state.changedFiles).toBe(2);
		expect(state.hasRepositoryMetadata).toBe(true);
	});

	it("prefers refreshed shared task metadata over stale home git metadata", () => {
		const state = resolveTaskGitState({
			projectRootPath: "/repo",
			card: {
				branch: "feature/old",
				useWorktree: false,
				workingDirectory: null,
			},
			repositoryInfo: {
				taskId: "task-1",
				path: "/repo",
				exists: true,
				baseRef: "main",
				branch: "feature/new",
				isDetached: false,
				headCommit: "abcdef123456",
			},
			worktreeSnapshot: {
				taskId: "task-1",
				path: "/repo",
				branch: "feature/new",
				isDetached: false,
				headCommit: "abcdef123456",
				changedFiles: 1,
				additions: 3,
				deletions: 2,
				hasUnmergedChanges: false,
				behindBaseCount: 4,
				conflictState: null,
			},
			homeGitSummary: {
				currentBranch: "feature/old",
				upstreamBranch: "origin/feature/old",
				changedFiles: 7,
				additions: 11,
				deletions: 5,
				aheadCount: 0,
				behindCount: 0,
			},
		});

		expect(state.identity.assignedPath).toBe("/repo");
		expect(state.branch).toBe("feature/new");
		expect(state.branchLabel).toBe("feature/new");
		expect(state.changedFiles).toBe(1);
		expect(state.additions).toBe(3);
		expect(state.deletions).toBe(2);
		expect(state.behindBaseCount).toBe(4);
	});

	it("uses task worktree metadata for isolated tasks", () => {
		const state = resolveTaskGitState({
			projectRootPath: "/repo",
			card: {
				branch: "feature/stale",
				useWorktree: true,
				workingDirectory: "/repo/.quarterdeck/worktrees/task-1",
			},
			repositoryInfo: {
				taskId: "task-1",
				path: "/repo/.quarterdeck/worktrees/task-1",
				exists: true,
				baseRef: "main",
				branch: "feature/current",
				isDetached: false,
				headCommit: "abcdef123456",
			},
			worktreeSnapshot: {
				taskId: "task-1",
				path: "/repo/.quarterdeck/worktrees/task-1",
				branch: "feature/current",
				isDetached: false,
				headCommit: "abcdef123456",
				changedFiles: 3,
				additions: 8,
				deletions: 2,
				hasUnmergedChanges: false,
				behindBaseCount: 1,
				conflictState: null,
			},
			homeGitSummary: {
				currentBranch: "main",
				upstreamBranch: "origin/main",
				changedFiles: 0,
				additions: 0,
				deletions: 0,
				aheadCount: 0,
				behindCount: 0,
			},
		});

		expect(state.identity.assignedPath).toBe("/repo/.quarterdeck/worktrees/task-1");
		expect(state.branch).toBe("feature/current");
		expect(state.branchLabel).toBe("feature/current");
		expect(state.changedFiles).toBe(3);
		expect(state.behindBaseCount).toBe(1);
	});
});
