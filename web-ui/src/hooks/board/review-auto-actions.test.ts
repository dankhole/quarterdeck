import { describe, expect, it } from "vitest";
import {
	AUTO_REVIEW_ACTION_DELAY_MS,
	buildColumnByTaskId,
	getReviewCardsForAutomation,
	isAutoTrashMode,
	isTaskAutoReviewEnabled,
} from "@/hooks/board/review-auto-actions";
import type { BoardCard, BoardData } from "@/types";

function card(overrides: Partial<BoardCard> & { id: string }): BoardCard {
	return {
		title: null,
		prompt: "test",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function board(columns: Array<{ id: string; cards: BoardCard[] }>): BoardData {
	return {
		columns: columns.map((c) => ({ id: c.id as BoardData["columns"][number]["id"], title: c.id, cards: c.cards })),
		dependencies: [],
	};
}

describe("isTaskAutoReviewEnabled", () => {
	it("returns true when autoReviewEnabled is true", () => {
		expect(isTaskAutoReviewEnabled(card({ id: "1", autoReviewEnabled: true }))).toBe(true);
	});

	it("returns false when autoReviewEnabled is false", () => {
		expect(isTaskAutoReviewEnabled(card({ id: "1", autoReviewEnabled: false }))).toBe(false);
	});

	it("returns false when autoReviewEnabled is undefined", () => {
		const c = card({ id: "1" });
		c.autoReviewEnabled = undefined as unknown as boolean;
		expect(isTaskAutoReviewEnabled(c)).toBe(false);
	});
});

describe("buildColumnByTaskId", () => {
	it("maps each task to its column", () => {
		const b = board([
			{ id: "backlog", cards: [card({ id: "t1" })] },
			{ id: "review", cards: [card({ id: "t2" })] },
			{ id: "trash", cards: [card({ id: "t3" })] },
		]);
		const map = buildColumnByTaskId(b);
		expect(map.get("t1")).toBe("backlog");
		expect(map.get("t2")).toBe("review");
		expect(map.get("t3")).toBe("trash");
	});

	it("returns empty map for empty board", () => {
		const b = board([]);
		expect(buildColumnByTaskId(b).size).toBe(0);
	});
});

describe("getReviewCardsForAutomation", () => {
	it("returns only auto-review-enabled cards from review column", () => {
		const b = board([
			{ id: "backlog", cards: [card({ id: "t1", autoReviewEnabled: true })] },
			{
				id: "review",
				cards: [
					card({ id: "t2", autoReviewEnabled: true }),
					card({ id: "t3", autoReviewEnabled: false }),
					card({ id: "t4", autoReviewEnabled: true }),
				],
			},
		]);
		const result = getReviewCardsForAutomation(b);
		expect(result.map((c) => c.id)).toEqual(["t2", "t4"]);
	});

	it("returns empty when no review column exists", () => {
		const b = board([{ id: "backlog", cards: [card({ id: "t1", autoReviewEnabled: true })] }]);
		expect(getReviewCardsForAutomation(b)).toEqual([]);
	});
});

describe("isAutoTrashMode", () => {
	it("returns true when autoReviewMode is move_to_trash", () => {
		expect(isAutoTrashMode(card({ id: "1", autoReviewMode: "move_to_trash" }))).toBe(true);
	});

	it("returns false when autoReviewMode is commit", () => {
		expect(isAutoTrashMode(card({ id: "1", autoReviewMode: "commit" }))).toBe(false);
	});
});

describe("AUTO_REVIEW_ACTION_DELAY_MS", () => {
	it("is 500ms", () => {
		expect(AUTO_REVIEW_ACTION_DELAY_MS).toBe(500);
	});
});
