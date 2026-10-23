// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveBoardCardViewModel } from "@/hooks/board/board-card";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import type { BoardCard, BoardColumnId, ReviewTaskWorktreeSnapshot } from "@/types";

const card: BoardCard = {
	id: "task-1",
	title: "Test task",
	prompt: "Test task",
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
};

describe("resolveBoardCardViewModel", () => {
	it("shows unstarted status without stale session or restart affordances", () => {
		const result = resolveBoardCardViewModel({
			card: { ...card, unstarted: true },
			columnId: "review",
			sessionSummary: createTestTaskSessionSummary({
				taskId: card.id,
				state: "awaiting_review",
				pid: null,
				completedResponses: [{ text: "Stale response", capturedAt: 1, sessionIndex: 0 }],
			}),
			reviewWorktreeSnapshot: null,
			workspacePath: "/tmp/project",
			isRestartDelayElapsed: true,
			hasRestartSessionHandler: true,
		});
		expect(result).toMatchObject({
			statusLabel: "Unstarted",
			showStatusBadge: true,
			isSessionDead: false,
			isSessionRestartable: false,
			showProjectStatus: false,
		});
	});
});

describe("resolveBoardCardViewModel uncommitted changes indicator", () => {
	const dirtyWorktree: ReviewTaskWorktreeSnapshot = {
		taskId: card.id,
		path: "/tmp/project/task-1",
		branch: "task-1",
		isDetached: false,
		headCommit: null,
		changedFiles: 2,
		additions: 3,
		deletions: 1,
		hasUnmergedChanges: false,
		behindBaseCount: 0,
		behindRemoteBaseCount: 0,
		conflictState: null,
	};

	function resolveIndicator(
		columnId: BoardColumnId,
		reviewWorktreeSnapshot: ReviewTaskWorktreeSnapshot | null = dirtyWorktree,
		unstarted = false,
	) {
		return resolveBoardCardViewModel({
			card: { ...card, unstarted },
			columnId,
			reviewWorktreeSnapshot,
			workspacePath: "/tmp/project",
			isRestartDelayElapsed: false,
			hasRestartSessionHandler: false,
		}).showUncommittedChangesIndicator;
	}

	it.each<BoardColumnId>(["in_progress", "review"])("shows uncommitted changes on a started %s card", (columnId) => {
		expect(resolveIndicator(columnId)).toBe(true);
	});

	it.each<BoardColumnId>(["in_progress", "review"])(
		"hides uncommitted changes on an unstarted %s card",
		(columnId) => {
			expect(resolveIndicator(columnId, dirtyWorktree, true)).toBe(false);
		},
	);

	it("hides uncommitted changes on a Trash card", () => {
		expect(resolveIndicator("trash")).toBe(false);
	});

	it("hides uncommitted changes until the worktree snapshot is available", () => {
		expect(resolveIndicator("review", null)).toBe(false);
	});

	it.each([0, null])("hides uncommitted changes when changedFiles is %s", (changedFiles) => {
		expect(resolveIndicator("review", { ...dirtyWorktree, changedFiles })).toBe(false);
	});
});
