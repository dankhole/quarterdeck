import type { TaskAnchor } from "./dependency-geometry";

interface Point {
	x: number;
	y: number;
}

/** Axis-aligned segments must stay outside every card, including during drag layout changes. */
function isClear(points: Point[], cards: TaskAnchor[]): boolean {
	return points.slice(1).every((end, index) => {
		const start = points[index]!;
		return cards.every((card) =>
			start.x === end.x
				? start.x <= card.left ||
					start.x >= card.right ||
					Math.max(start.y, end.y) <= card.top ||
					Math.min(start.y, end.y) >= card.bottom
				: start.y <= card.top ||
					start.y >= card.bottom ||
					Math.max(start.x, end.x) <= card.left ||
					Math.min(start.x, end.x) >= card.right,
		);
	});
}

/** Grid rows have a shared top edge and a 14px gap. Use those gutters, never interpolate through cards. */
export function computeGridDependencyRoute(
	source: TaskAnchor,
	target: TaskAnchor,
	sourceLane: number,
	targetLane: number,
	cards: TaskAnchor[],
	bounds: { width: number; height: number },
): { path: string; midpointX: number; midpointY: number; points: Point[] } | null {
	const candidates: Point[][] = [];
	if (source.centerY === target.centerY) {
		const forward = source.centerX < target.centerX;
		candidates.push([
			{ x: forward ? source.right + 2 : source.left - 2, y: source.centerY },
			{ x: forward ? target.left - 4 : target.right + 4, y: target.centerY },
		]);
	}
	if (source.centerX === target.centerX) {
		const forward = source.centerY < target.centerY;
		candidates.push([
			{ x: source.centerX, y: forward ? source.bottom + 2 : source.top - 2 },
			{ x: target.centerX, y: forward ? target.top - 4 : target.bottom + 4 },
		]);
	}
	const portX = (card: TaskAnchor, lane: number) =>
		Math.max(card.left + 12, Math.min(card.right - 12, card.centerX + lane));
	const start = { x: portX(source, sourceLane), y: source.top - 2 };
	const end = { x: portX(target, targetLane), y: target.top - 4 };
	const from = { x: start.x, y: source.top - 7 };
	const to = { x: end.x, y: target.top - 7 };
	if (from.y === to.y) candidates.push([start, from, to, end]);
	const left = Math.max(2, Math.min(...cards.map((card) => card.left)) - 10);
	const right = Math.min(bounds.width - 2, Math.max(...cards.map((card) => card.right)) + 10);
	for (const x of [left, right]) candidates.push([start, from, { x, y: from.y }, { x, y: to.y }, to, end]);
	const length = (points: Point[]) =>
		points
			.slice(1)
			.reduce((sum, end, index) => sum + Math.abs(end.x - points[index]!.x) + Math.abs(end.y - points[index]!.y), 0);
	const points = candidates
		.filter(
			(route) =>
				route.every(
					(point) => point.x >= 0 && point.x <= bounds.width && point.y >= 0 && point.y <= bounds.height,
				) && isClear(route, cards),
		)
		.sort((a, b) => length(a) - length(b))[0];
	// Transient overlapping drag positions may have no safe route. Resume drawing after layout settles.
	if (!points) return null;
	let remaining = length(points) / 2;
	let midpoint = points[0]!;
	for (let index = 1; index < points.length; index++) {
		const start = points[index - 1]!;
		const end = points[index]!;
		const distance = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
		if (distance > 0 && remaining <= distance) {
			midpoint = {
				x: start.x + ((end.x - start.x) * remaining) / distance,
				y: start.y + ((end.y - start.y) * remaining) / distance,
			};
			break;
		}
		remaining -= distance;
	}
	return {
		path: points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" "),
		midpointX: midpoint.x,
		midpointY: midpoint.y,
		points,
	};
}
