import { describe, expect, it } from "vitest";

import { resolveDefaultCompareSourceRef } from "@/hooks/git/use-git-view-compare";
import type { RuntimeGitSyncSummary, RuntimeTaskRepositoryInfoResponse } from "@/runtime/types";
import type { BoardCard, BoardColumn, CardSelection, ReviewTaskWorktreeSnapshot } from "@/types";

function createSelection(card: Partial<BoardCard> = {}): CardSelection {
	const resolvedCard: BoardCard = {
		id: "task-1",
		title: null,
		prompt: "Task",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...card,
	};
	const column: BoardColumn = { id: "review", title: "Review", cards: [resolvedCard] };
	return { card: resolvedCard, column, allColumns: [column] };
}

const homeGitSummary: RuntimeGitSyncSummary = {
	currentBranch: "main",
	upstreamBranch: "origin/main",
	changedFiles: 0,
	additions: 0,
	deletions: 0,
	aheadCount: 0,
	behindCount: 0,
};

describe("resolveDefaultCompareSourceRef", () => {
	it("uses refreshed shared-checkout repository metadata for task compare defaults", () => {
		const repositoryInfo: RuntimeTaskRepositoryInfoResponse = {
			taskId: "task-1",
			path: "/repo",
			exists: true,
			baseRef: "main",
			branch: "feature/current",
			isDetached: false,
			headCommit: "abcdef123456",
		};

		expect(
			resolveDefaultCompareSourceRef({
				selectedCard: createSelection({ branch: "feature/stale", useWorktree: false }),
				projectPath: "/repo",
				homeGitSummary,
				repositoryInfo,
				worktreeSnapshot: null,
			}),
		).toBe("feature/current");
	});

	it("falls back to home git metadata for shared-checkout tasks before task metadata refreshes", () => {
		const repositoryInfo: RuntimeTaskRepositoryInfoResponse = {
			taskId: "task-1",
			path: "/repo/.quarterdeck/worktrees/task-1",
			exists: false,
			baseRef: "main",
			branch: null,
			isDetached: false,
			headCommit: null,
		};

		expect(
			resolveDefaultCompareSourceRef({
				selectedCard: createSelection({ branch: null, useWorktree: false }),
				projectPath: "/repo",
				homeGitSummary,
				repositoryInfo,
				worktreeSnapshot: null,
			}),
		).toBe("main");
	});

	it("uses isolated task worktree snapshots when available", () => {
		const worktreeSnapshot: ReviewTaskWorktreeSnapshot = {
			taskId: "task-1",
			path: "/repo/.quarterdeck/worktrees/task-1",
			branch: "feature/from-snapshot",
			isDetached: false,
			headCommit: "abcdef123456",
			changedFiles: 1,
			additions: 2,
			deletions: 1,
			hasUnmergedChanges: false,
			behindBaseCount: 0,
			conflictState: null,
		};

		expect(
			resolveDefaultCompareSourceRef({
				selectedCard: createSelection({
					branch: "feature/stale",
					useWorktree: true,
					workingDirectory: "/repo/.quarterdeck/worktrees/task-1",
				}),
				projectPath: "/repo",
				homeGitSummary,
				repositoryInfo: null,
				worktreeSnapshot,
			}),
		).toBe("feature/from-snapshot");
	});
});
