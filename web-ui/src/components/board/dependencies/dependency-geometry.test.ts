import { describe, expect, it } from "vitest";
import { computePath, type TaskAnchor } from "@/components/board/dependencies/dependency-geometry";

function anchor(columnId: TaskAnchor["columnId"], left: number, top: number): TaskAnchor {
	return { columnId, left, right: left + 200, top, bottom: top + 100, centerX: left + 100, centerY: top + 50 };
}

describe("dependency paths", () => {
	it("routes stacked grid cards through their bottom and top edges", () => {
		const source = anchor("review", 250, 20);
		const target = anchor("review", 250, 160);
		const { geometry, startSide, endSide } = computePath(source, target, 0, 0);
		expect([startSide, endSide]).toEqual(["bottom", "top"]);
		expect(geometry.controlPoint1Y).toBeGreaterThan(source.bottom);
		expect(geometry.controlPoint2Y).toBeLessThan(target.top);
	});

	it("connects In Progress and Review through facing edges in either direction", () => {
		const running = anchor("in_progress", 20, 20);
		const review = anchor("review", 250, 20);
		expect(computePath(running, review, 0, 0)).toMatchObject({ startSide: "right", endSide: "left" });
		expect(computePath(review, running, 0, 0)).toMatchObject({ startSide: "left", endSide: "right" });
	});

	it("connects adjacent cards in the same section horizontally", () => {
		expect(computePath(anchor("review", 0, 20), anchor("review", 240, 20), 0, 0)).toMatchObject({
			startSide: "right",
			endSide: "left",
		});
	});

	it("faces the pointer on either side when drafting a link from Review", () => {
		const review = anchor("review", 250, 160);
		expect(computePath(review, anchor(null, 20, 160), 0, 0).startSide).toBe("left");
		expect(computePath(review, anchor(null, 500, 160), 0, 0).startSide).toBe("right");
	});
});
