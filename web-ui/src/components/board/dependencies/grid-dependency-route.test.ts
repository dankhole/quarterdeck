import { describe, expect, it } from "vitest";
import type { TaskAnchor } from "./dependency-geometry";
import { computeGridDependencyRoute } from "./grid-dependency-route";

const card = (left: number, top: number, height = 260): TaskAnchor => ({
	left,
	right: left + 360,
	top,
	bottom: top + height,
	centerX: left + 180,
	centerY: top + height / 2,
	columnId: "review",
});
const bounds = { width: 1156, height: 1200 };

describe("grid dependency routing", () => {
	it.each([
		[card(24, 60), card(398, 60), card(772, 60)],
		[card(24, 60), card(24, 334), card(24, 608)],
	])("routes around the middle card in a row or column", (source, middle, target) => {
		const route = computeGridDependencyRoute(source, target, 0, 0, [source, middle, target], bounds)!;
		expect(route).not.toBeNull();
		for (let i = 1; i < route.points.length; i++) {
			const start = route.points[i - 1]!;
			const end = route.points[i]!;
			// Sample the whole route, not just its midpoint; arrow and hit-path use this same geometry.
			for (let t = 0; t <= 1; t += 0.01) {
				const x = start.x + (end.x - start.x) * t;
				const y = start.y + (end.y - start.y) * t;
				expect(x > middle.left && x < middle.right && y > middle.top && y < middle.bottom).toBe(false);
			}
		}
	});
	it("uses the outer gutter across rows with unequal card heights", () => {
		const cards = [card(24, 60), card(398, 60, 400), card(772, 60), card(24, 474), card(398, 474), card(772, 474)];
		const route = computeGridDependencyRoute(cards[0]!, cards[5]!, 9, -9, cards, bounds)!;
		expect(route).not.toBeNull();
		expect(route.points.some((point) => point.x < 24 || point.x > 1132)).toBe(true);
	});
	it("keeps adjacent links short and hides an unsafe overlapping drag route", () => {
		const source = card(24, 60);
		const target = card(398, 60);
		expect(computeGridDependencyRoute(source, target, 0, 0, [source, target], bounds)?.points).toHaveLength(2);
		expect(
			computeGridDependencyRoute(source, card(24, 20, 500), 0, 0, [source, card(24, 20, 500)], bounds),
		).toBeNull();
	});
});
