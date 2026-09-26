import { describe, expect, it } from "vitest";
import { resolveBoardCardViewModel } from "@/hooks/board/board-card";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import type { BoardCard } from "@/types";

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
		uncommittedChangesOnCardsEnabled: false,
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
			uncommittedChangesOnCardsEnabled: true,
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
