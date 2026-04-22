import { describe, expect, it } from "vitest";

import { resolveTaskIdentity } from "@/utils/task-identity";

describe("resolveTaskIdentity", () => {
	it("prefers assigned metadata for task path and branch display", () => {
		const identity = resolveTaskIdentity({
			projectRootPath: "/repo",
			card: {
				branch: "stale-branch",
				useWorktree: true,
				workingDirectory: "/repo/.quarterdeck/worktrees/task-1",
			},
			worktreeInfo: {
				taskId: "task-1",
				path: "/repo/.quarterdeck/worktrees/task-1",
				exists: true,
				baseRef: "main",
				branch: "feature/fresh-branch",
				isDetached: false,
				headCommit: "abcdef1234567890",
			},
			sessionSummary: {
				sessionLaunchPath: "/repo/.quarterdeck/worktrees/task-1",
			},
		});

		expect(identity.assignedPath).toBe("/repo/.quarterdeck/worktrees/task-1");
		expect(identity.assignedBranch).toBe("feature/fresh-branch");
		expect(identity.displayBranchLabel).toBe("feature/fresh-branch");
		expect(identity.isAssignedShared).toBe(false);
		expect(identity.isSessionLaunchDiverged).toBe(false);
	});

	it("treats detached assigned identity as commit display even when a stale card branch exists", () => {
		const identity = resolveTaskIdentity({
			projectRootPath: "/repo",
			card: {
				branch: "feature/stale-branch",
				useWorktree: true,
				workingDirectory: "/repo/.quarterdeck/worktrees/task-1",
			},
			worktreeSnapshot: {
				taskId: "task-1",
				path: "/repo/.quarterdeck/worktrees/task-1",
				branch: null,
				isDetached: true,
				headCommit: "deadbeef12345678",
				changedFiles: 0,
				additions: 0,
				deletions: 0,
				hasUnmergedChanges: false,
				behindBaseCount: null,
				conflictState: null,
			},
		});

		expect(identity.assignedBranch).toBeNull();
		expect(identity.assignedIsDetached).toBe(true);
		expect(identity.displayBranchLabel).toBe("deadbeef");
	});

	it("falls back to project root for explicitly shared tasks with no persisted path", () => {
		const identity = resolveTaskIdentity({
			projectRootPath: "/repo",
			card: {
				branch: null,
				useWorktree: false,
				workingDirectory: null,
			},
		});

		expect(identity.assignedPath).toBe("/repo");
		expect(identity.isAssignedShared).toBe(true);
		expect(identity.isSessionLaunchShared).toBe(false);
	});

	it("keeps assigned shared state separate from live execution drift", () => {
		const identity = resolveTaskIdentity({
			projectRootPath: "/repo",
			card: {
				branch: "feature/task",
				useWorktree: true,
				workingDirectory: "/repo/.quarterdeck/worktrees/task-1",
			},
			worktreeSnapshot: {
				taskId: "task-1",
				path: "/repo/.quarterdeck/worktrees/task-1",
				branch: "feature/task",
				isDetached: false,
				headCommit: "abcdef1",
				changedFiles: 3,
				additions: 10,
				deletions: 2,
				hasUnmergedChanges: false,
				behindBaseCount: null,
				conflictState: null,
			},
			sessionSummary: {
				sessionLaunchPath: "/repo",
			},
		});

		expect(identity.isAssignedShared).toBe(false);
		expect(identity.isSessionLaunchShared).toBe(true);
		expect(identity.isSessionLaunchDiverged).toBe(true);
	});

	it("preserves literal backslashes in unix-style paths", () => {
		const identity = resolveTaskIdentity({
			projectRootPath: "/tmp/weird\\name",
			card: {
				branch: null,
				useWorktree: false,
				workingDirectory: null,
			},
		});

		expect(identity.projectRootPath).toBe("/tmp/weird\\name");
		expect(identity.assignedPath).toBe("/tmp/weird\\name");
	});

	it("normalizes windows-style separators for path comparison", () => {
		const identity = resolveTaskIdentity({
			projectRootPath: "C:\\repo",
			card: {
				branch: null,
				useWorktree: true,
				workingDirectory: "C:\\repo\\.quarterdeck\\worktrees\\task-1\\",
			},
			sessionSummary: {
				sessionLaunchPath: "C:\\repo\\.quarterdeck\\worktrees\\task-1",
			},
		});

		expect(identity.projectRootPath).toBe("C:/repo");
		expect(identity.assignedPath).toBe("C:/repo/.quarterdeck/worktrees/task-1");
		expect(identity.sessionLaunchPath).toBe("C:/repo/.quarterdeck/worktrees/task-1");
		expect(identity.isSessionLaunchDiverged).toBe(false);
	});
});
