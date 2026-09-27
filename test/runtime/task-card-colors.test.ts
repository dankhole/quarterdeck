import { describe, expect, it } from "vitest";
import { allocateTaskColor, assignMissingTaskColors, TASK_CARD_COLORS } from "../../src/core/task-card-colors";

describe("task card colors", () => {
	it("uses all forty colors before repeating and balances overflow", () => {
		const cards: { colorIndex: number }[] = [];
		for (let index = 0; index < 80; index++) cards.push({ colorIndex: allocateTaskColor(`task-${index}`, cards) });
		expect(new Set(TASK_CARD_COLORS).size).toBe(40);
		expect(new Set(cards.slice(0, 40).map((card) => card.colorIndex)).size).toBe(40);
		for (let color = 0; color < 40; color++)
			expect(cards.filter((card) => card.colorIndex === color)).toHaveLength(2);
	});
	it("backfills legacy cards independently of column order and preserves saved assignments", () => {
		const cards = [
			{ id: "a", createdAt: 1 },
			{ id: "b", createdAt: 2 },
			{ id: "saved", createdAt: 3, colorIndex: 4 },
		];
		const first = assignMissingTaskColors({ columns: [{ cards: structuredClone(cards) }] });
		const second = assignMissingTaskColors({ columns: [{ cards: structuredClone(cards).reverse() }] });
		expect(first.columns[0]?.cards).toEqual(second.columns[0]?.cards.reverse());
		expect(first.columns[0]?.cards[2]?.colorIndex).toBe(4);
		expect(assignMissingTaskColors(structuredClone(first))).toEqual(first);
	});
});
