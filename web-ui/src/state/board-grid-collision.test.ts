// @vitest-environment node

import type { ClientRect, CollisionDetection } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { boardGridCollision } from "@/state/board-grid-collision";

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
	left,
	top,
	width,
	height,
	right: left + width,
	bottom: top + height,
});
function args(collisionRect: ClientRect): Parameters<CollisionDetection>[0] {
	const rects = new Map([
		["review", rect(0, 0, 1200, 300)],
		["task", rect(0, 0, 400, 300)],
		["trash", rect(0, 330, 1200, 58)],
	]);
	return {
		active: {
			id: "task",
			data: { current: {} },
			rect: { current: { initial: rects.get("task")!, translated: collisionRect } },
		},
		collisionRect,
		droppableRects: rects,
		droppableContainers: [...rects].map(([id, bounds]) => ({
			id,
			key: id,
			disabled: false,
			data: { current: {} },
			node: { current: null },
			rect: { current: bounds },
		})),
		pointerCoordinates: null,
	};
}
describe("board grid collision", () => {
	it("lets keyboard moves reach collapsed Trash despite its different dimensions", () => {
		expect(boardGridCollision(args(rect(0, 330, 400, 300)))[0]?.id).toBe("trash");
	});
	it("prefers a pointed card to its section and does not snap outside the board", () => {
		const input = args(rect(0, 0, 400, 300));
		expect(boardGridCollision({ ...input, pointerCoordinates: { x: 50, y: 50 } })[0]?.id).toBe("task");
		expect(boardGridCollision({ ...input, pointerCoordinates: { x: 1500, y: 500 } })).toEqual([]);
	});
});
