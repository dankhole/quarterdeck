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

function resolveSummaryDisplay(showSummaryOnCards: boolean, showSummaryOnHover: boolean) {
	return resolveBoardCardViewModel({
		card,
		columnId: "in_progress",
		sessionSummary: createTestTaskSessionSummary({
			taskId: card.id,
			state: "running",
			displaySummary: "Latest conversation summary",
		}),
		reviewWorktreeSnapshot: null,
		workspacePath: "/tmp/project",
		showSummaryOnCards,
		showSummaryOnHover,
		isRestartDelayElapsed: false,
		hasRestartSessionHandler: false,
	});
}

describe("resolveBoardCardViewModel summary display", () => {
	it("shows unstarted status without stale session or restart affordances", () => {
		const result = resolveBoardCardViewModel({
			card: { ...card, unstarted: true },
			columnId: "review",
			sessionSummary: createTestTaskSessionSummary({
				taskId: card.id,
				state: "awaiting_review",
				pid: null,
				displaySummary: "Stale summary",
			}),
			reviewWorktreeSnapshot: null,
			workspacePath: "/tmp/project",
			showSummaryOnCards: true,
			showSummaryOnHover: true,
			isRestartDelayElapsed: true,
			hasRestartSessionHandler: true,
		});
		expect(result).toMatchObject({
			statusLabel: "Unstarted",
			showStatusBadge: true,
			isSessionDead: false,
			isSessionRestartable: false,
			showProjectStatus: false,
			latestSummaryText: null,
			effectiveTooltip: null,
		});
	});

	it("shows the summary only in the hover tooltip in hover mode", () => {
		const result = resolveSummaryDisplay(false, true);

		expect(result.isSummaryVisibleOnCard).toBe(false);
		expect(result.effectiveTooltip).toBe("Latest conversation summary");
	});

	it("shows the summary only on the card in card mode", () => {
		const result = resolveSummaryDisplay(true, false);

		expect(result.isSummaryVisibleOnCard).toBe(true);
		expect(result.effectiveTooltip).toBeNull();
	});

	it("suppresses both summary surfaces in hidden mode", () => {
		const result = resolveSummaryDisplay(false, false);

		expect(result.isSummaryVisibleOnCard).toBe(false);
		expect(result.effectiveTooltip).toBeNull();
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
			showSummaryOnCards: false,
			showSummaryOnHover: true,
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
