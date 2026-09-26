import { describe, expect, it } from "vitest";
import { sortColumnCards } from "@/state/sort-column-cards";
import type { BoardCard } from "@/types";

function task(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
	return { id, title: null, prompt: id, baseRef: "main", createdAt: 1, updatedAt: 1, ...overrides };
}

describe("sortColumnCards", () => {
	it("keeps started Review tasks ahead of unstarted tasks, with pinning inside each group", () => {
		const cards = [
			task("queued", { unstarted: true, updatedAt: 100 }),
			task("completed"),
			task("queued-pinned", { unstarted: true, pinned: true }),
			task("completed-pinned", { pinned: true }),
			task("queued-later", { unstarted: true, updatedAt: 200 }),
		];
		expect(sortColumnCards(cards, "review").map((card) => card.id)).toEqual([
			"completed-pinned",
			"completed",
			"queued-pinned",
			"queued",
			"queued-later",
		]);
		expect(cards[0]?.id).toBe("queued");
	});
});
