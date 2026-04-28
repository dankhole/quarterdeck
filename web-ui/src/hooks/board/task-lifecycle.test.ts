import { describe, expect, it } from "vitest";
import type { BoardCard, BoardData } from "@/types";
import {
	applyDeferredMoveToInProgress,
	buildWorktreeInfoFromEnsureResponse,
	isNonIsolatedTask,
	revertOptimisticMoveToInProgress,
	revertOptimisticMoveToReview,
} from "./task-lifecycle";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "task-1",
		title: "Test task",
		prompt: "Do the thing",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function makeBoard(columns: Record<string, BoardCard[]>): BoardData {
	const allColumnIds = ["backlog", "in_progress", "review", "trash"] as const;
	return {
		columns: allColumnIds.map((id) => ({
			id,
			title: id,
			cards: columns[id] ?? [],
		})),
		dependencies: [],
	};
}

// ---------------------------------------------------------------------------
// isNonIsolatedTask
// ---------------------------------------------------------------------------

describe("isNonIsolatedTask", () => {
	it("returns true when useWorktree is false", () => {
		expect(isNonIsolatedTask(makeCard({ useWorktree: false }))).toBe(true);
	});

	it("returns false when useWorktree is true", () => {
		expect(isNonIsolatedTask(makeCard({ useWorktree: true }))).toBe(false);
	});

	it("returns false when useWorktree is undefined (default behavior)", () => {
		expect(isNonIsolatedTask(makeCard({ useWorktree: undefined }))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildWorktreeInfoFromEnsureResponse
// ---------------------------------------------------------------------------

describe("buildWorktreeInfoFromEnsureResponse", () => {
	it("maps ensure response fields to worktree info shape", () => {
		const result = buildWorktreeInfoFromEnsureResponse("task-1", {
			ok: true,
			path: "/tmp/worktrees/task-1",
			baseRef: "main",
			baseCommit: "abc123",
			branch: "task-1-branch",
		});

		expect(result).toEqual({
			taskId: "task-1",
			path: "/tmp/worktrees/task-1",
			exists: true,
			baseRef: "main",
			branch: "task-1-branch",
			isDetached: false,
			headCommit: "abc123",
		});
	});

	it("sets isDetached to true when branch is null", () => {
		const result = buildWorktreeInfoFromEnsureResponse("task-2", {
			ok: true,
			path: "/tmp/worktrees/task-2",
			baseRef: "develop",
			baseCommit: "def456",
			branch: null,
		});

		expect(result.isDetached).toBe(true);
		expect(result.branch).toBeNull();
	});

	it("sets isDetached to true when branch is undefined", () => {
		const result = buildWorktreeInfoFromEnsureResponse("task-3", {
			ok: true,
			path: "/tmp/worktrees/task-3",
			baseRef: "main",
			baseCommit: "ghi789",
		});

		expect(result.isDetached).toBe(true);
		expect(result.branch).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// revertOptimisticMoveToInProgress
// ---------------------------------------------------------------------------

describe("revertOptimisticMoveToInProgress", () => {
	it("reverts task from in_progress back to the original column", () => {
		const card = makeCard();
		const board = makeBoard({ in_progress: [card] });

		const result = revertOptimisticMoveToInProgress(board, "task-1", "backlog");

		expect(result).not.toBeNull();
		const backlog = result!.columns.find((c) => c.id === "backlog");
		const inProgress = result!.columns.find((c) => c.id === "in_progress");
		expect(backlog?.cards).toHaveLength(1);
		expect(backlog?.cards[0]?.id).toBe("task-1");
		expect(inProgress?.cards).toHaveLength(0);
	});

	it("returns null when task is not in in_progress column", () => {
		const card = makeCard();
		const board = makeBoard({ review: [card] });

		const result = revertOptimisticMoveToInProgress(board, "task-1", "backlog");

		expect(result).toBeNull();
	});

	it("returns null when task does not exist in any column", () => {
		const board = makeBoard({});

		const result = revertOptimisticMoveToInProgress(board, "nonexistent", "backlog");

		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// revertOptimisticMoveToReview
// ---------------------------------------------------------------------------

describe("revertOptimisticMoveToReview", () => {
	it("reverts task from review back to trash", () => {
		const card = makeCard();
		const board = makeBoard({ review: [card] });

		const result = revertOptimisticMoveToReview(board, "task-1");

		expect(result).not.toBeNull();
		const review = result!.columns.find((c) => c.id === "review");
		const trash = result!.columns.find((c) => c.id === "trash");
		expect(review?.cards).toHaveLength(0);
		expect(trash?.cards).toHaveLength(1);
		expect(trash?.cards[0]?.id).toBe("task-1");
	});

	it("returns null when task is not in review column", () => {
		const card = makeCard();
		const board = makeBoard({ in_progress: [card] });

		const result = revertOptimisticMoveToReview(board, "task-1");

		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// applyDeferredMoveToInProgress
// ---------------------------------------------------------------------------

describe("applyDeferredMoveToInProgress", () => {
	it("moves task from the expected column to in_progress", () => {
		const card = makeCard();
		const board = makeBoard({ backlog: [card] });

		const result = applyDeferredMoveToInProgress(board, "task-1", "backlog");

		expect(result).not.toBeNull();
		const backlog = result!.columns.find((c) => c.id === "backlog");
		const inProgress = result!.columns.find((c) => c.id === "in_progress");
		expect(backlog?.cards).toHaveLength(0);
		expect(inProgress?.cards).toHaveLength(1);
		expect(inProgress?.cards[0]?.id).toBe("task-1");
	});

	it("returns null when task is no longer in the expected column", () => {
		const card = makeCard();
		const board = makeBoard({ review: [card] });

		const result = applyDeferredMoveToInProgress(board, "task-1", "backlog");

		expect(result).toBeNull();
	});

	it("returns null when task does not exist", () => {
		const board = makeBoard({});

		const result = applyDeferredMoveToInProgress(board, "nonexistent", "backlog");

		expect(result).toBeNull();
	});
});
