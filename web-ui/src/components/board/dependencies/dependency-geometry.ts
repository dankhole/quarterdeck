import type { BoardColumnId, BoardDependency } from "@/types";

export interface TaskAnchor {
	left: number;
	right: number;
	top: number;
	bottom: number;
	centerX: number;
	centerY: number;
	columnId: BoardColumnId | null;
}

export interface DependencyLayout {
	width: number;
	height: number;
	anchors: Record<string, TaskAnchor>;
}

export interface RenderedDependency {
	dependency: BoardDependency;
	geometry: DependencyGeometry;
	path: string;
	midpointX: number;
	midpointY: number;
	startSide: AnchorSide;
	endSide: AnchorSide;
	isTransient: boolean;
}

export interface DependencyGeometry {
	startX: number;
	startY: number;
	controlPoint1X: number;
	controlPoint1Y: number;
	controlPoint2X: number;
	controlPoint2Y: number;
	endX: number;
	endY: number;
	midpointX: number;
	midpointY: number;
	startSide: AnchorSide;
	endSide: AnchorSide;
}

export type AnchorSide = "left" | "right" | "top" | "bottom";

interface AnchorPoint {
	x: number;
	y: number;
	side: AnchorSide;
}

const SOURCE_CONNECTOR_PADDING = 2;
const TARGET_CONNECTOR_PADDING = 8;
const COLUMN_ORDER: BoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
const SIDE_NORMALS: Record<AnchorSide, { x: number; y: number }> = {
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
	top: { x: 0, y: -1 },
	bottom: { x: 0, y: 1 },
};

function getColumnOrder(columnId: BoardColumnId | null): number | null {
	if (!columnId) {
		return null;
	}
	const index = COLUMN_ORDER.indexOf(columnId);
	return index === -1 ? null : index;
}

export function cubicPoint(
	t: number,
	p0x: number,
	p0y: number,
	p1x: number,
	p1y: number,
	p2x: number,
	p2y: number,
	p3x: number,
	p3y: number,
): { x: number; y: number } {
	const inverse = 1 - t;
	const inverseSquared = inverse * inverse;
	const inverseCubed = inverseSquared * inverse;
	const tSquared = t * t;
	const tCubed = tSquared * t;
	return {
		x: inverseCubed * p0x + 3 * inverseSquared * t * p1x + 3 * inverse * tSquared * p2x + tCubed * p3x,
		y: inverseCubed * p0y + 3 * inverseSquared * t * p1y + 3 * inverse * tSquared * p2y + tCubed * p3y,
	};
}

export function buildPathFromGeometry(geometry: DependencyGeometry): string {
	return `M ${geometry.startX} ${geometry.startY} C ${geometry.controlPoint1X} ${geometry.controlPoint1Y} ${geometry.controlPoint2X} ${geometry.controlPoint2Y} ${geometry.endX} ${geometry.endY}`;
}

export function interpolateDependencyGeometry(
	from: DependencyGeometry,
	to: DependencyGeometry,
	progress: number,
): DependencyGeometry {
	const interpolate = (fromValue: number, toValue: number) => fromValue + (toValue - fromValue) * progress;
	const startX = interpolate(from.startX, to.startX);
	const startY = interpolate(from.startY, to.startY);
	const controlPoint1X = interpolate(from.controlPoint1X, to.controlPoint1X);
	const controlPoint1Y = interpolate(from.controlPoint1Y, to.controlPoint1Y);
	const controlPoint2X = interpolate(from.controlPoint2X, to.controlPoint2X);
	const controlPoint2Y = interpolate(from.controlPoint2Y, to.controlPoint2Y);
	const endX = interpolate(from.endX, to.endX);
	const endY = interpolate(from.endY, to.endY);
	const midpoint = cubicPoint(
		0.5,
		startX,
		startY,
		controlPoint1X,
		controlPoint1Y,
		controlPoint2X,
		controlPoint2Y,
		endX,
		endY,
	);
	return {
		startX,
		startY,
		controlPoint1X,
		controlPoint1Y,
		controlPoint2X,
		controlPoint2Y,
		endX,
		endY,
		midpointX: midpoint.x,
		midpointY: midpoint.y,
		startSide: to.startSide,
		endSide: to.endSide,
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function normalizeColumnId(value: string | undefined): BoardColumnId | null {
	if (value === "backlog" || value === "in_progress" || value === "review" || value === "trash") {
		return value;
	}
	return null;
}

function dot(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return a.x * b.x + a.y * b.y;
}

function getAnchorPoint(anchor: TaskAnchor, side: AnchorSide, laneOffset: number, padding: number): AnchorPoint {
	if (side === "left") {
		return {
			x: anchor.left - padding,
			y: anchor.centerY + laneOffset,
			side,
		};
	}
	if (side === "right") {
		return {
			x: anchor.right + padding,
			y: anchor.centerY + laneOffset,
			side,
		};
	}
	if (side === "top") {
		return {
			x: anchor.centerX + laneOffset,
			y: anchor.top - padding,
			side,
		};
	}
	return {
		x: anchor.centerX + laneOffset,
		y: anchor.bottom + padding,
		side,
	};
}

function chooseConnection(
	firstAnchor: TaskAnchor,
	secondAnchor: TaskAnchor,
	firstLaneOffset: number,
	secondLaneOffset: number,
	firstPadding: number,
	secondPadding: number,
): { start: AnchorPoint; end: AnchorPoint } {
	// Rendered links currently only survive when at least one endpoint is in backlog.
	// Draft links may still target free pointer space while the user is dragging.
	// Routing rules:
	// 1) If both cards are in backlog, connect right -> right.
	// 2) If cards are in different columns, preserve first -> second direction while preferring
	//    right -> left for forward links and left -> right for backward links.
	// 3) Otherwise fall back to the cheapest side-pairing based on geometry.
	const firstColumnId = firstAnchor.columnId;
	const secondColumnId = secondAnchor.columnId;
	const firstColumnOrder = getColumnOrder(firstColumnId);
	const secondColumnOrder = getColumnOrder(secondColumnId);

	if (secondColumnId === null) {
		const sourceSide: AnchorSide =
			firstColumnId === "backlog"
				? "right"
				: firstColumnId === "in_progress" || firstColumnId === "review"
					? "left"
					: "left";
		const targetSide: AnchorSide = sourceSide === "right" ? "left" : "right";
		return {
			start: getAnchorPoint(firstAnchor, sourceSide, firstLaneOffset, firstPadding),
			end: getAnchorPoint(secondAnchor, targetSide, secondLaneOffset, secondPadding),
		};
	}

	if (firstColumnId === null) {
		const targetSide: AnchorSide =
			secondColumnId === "backlog" || secondColumnId === "in_progress" || secondColumnId === "review"
				? "right"
				: "left";
		const sourceSide: AnchorSide = targetSide === "right" ? "left" : "right";
		return {
			start: getAnchorPoint(firstAnchor, sourceSide, firstLaneOffset, firstPadding),
			end: getAnchorPoint(secondAnchor, targetSide, secondLaneOffset, secondPadding),
		};
	}

	if (
		firstColumnId &&
		secondColumnId &&
		firstColumnId === secondColumnId &&
		(firstColumnId === "backlog" || firstColumnId === "in_progress" || firstColumnId === "review")
	) {
		return {
			start: getAnchorPoint(firstAnchor, "right", firstLaneOffset, firstPadding),
			end: getAnchorPoint(secondAnchor, "right", secondLaneOffset, secondPadding),
		};
	}

	if (firstColumnOrder !== null && secondColumnOrder !== null && firstColumnOrder !== secondColumnOrder) {
		if (firstColumnOrder < secondColumnOrder) {
			return {
				start: getAnchorPoint(firstAnchor, "right", firstLaneOffset, firstPadding),
				end: getAnchorPoint(secondAnchor, "left", secondLaneOffset, secondPadding),
			};
		}
		return {
			start: getAnchorPoint(firstAnchor, "left", firstLaneOffset, firstPadding),
			end: getAnchorPoint(secondAnchor, "right", secondLaneOffset, secondPadding),
		};
	}

	const firstSides: AnchorSide[] = ["left", "right", "top", "bottom"];
	const secondSides: AnchorSide[] = ["left", "right", "top", "bottom"];
	let best: {
		cost: number;
		start: AnchorPoint;
		end: AnchorPoint;
	} | null = null;

	for (const firstSide of firstSides) {
		for (const secondSide of secondSides) {
			const start = getAnchorPoint(firstAnchor, firstSide, firstLaneOffset, firstPadding);
			const end = getAnchorPoint(secondAnchor, secondSide, secondLaneOffset, secondPadding);
			const vector = { x: end.x - start.x, y: end.y - start.y };
			const distance = Math.hypot(vector.x, vector.y);
			const startFacing = dot(SIDE_NORMALS[firstSide], vector);
			const endFacing = dot(SIDE_NORMALS[secondSide], { x: -vector.x, y: -vector.y });
			const startFacingPenalty = startFacing < 0 ? 140 + Math.abs(startFacing) * 0.6 : 0;
			const endFacingPenalty = endFacing < 0 ? 140 + Math.abs(endFacing) * 0.6 : 0;
			const cost = distance + startFacingPenalty + endFacingPenalty;
			if (!best || cost < best.cost) {
				best = {
					cost,
					start,
					end,
				};
			}
		}
	}

	if (best) {
		return {
			start: best.start,
			end: best.end,
		};
	}

	return {
		start: getAnchorPoint(firstAnchor, "right", firstLaneOffset, firstPadding),
		end: getAnchorPoint(secondAnchor, "left", secondLaneOffset, secondPadding),
	};
}

export function computePath(
	firstAnchor: TaskAnchor,
	secondAnchor: TaskAnchor,
	firstLaneOffset: number,
	secondLaneOffset: number,
	bounds?: { width: number; height: number },
): {
	geometry: DependencyGeometry;
	path: string;
	midpointX: number;
	midpointY: number;
	startSide: AnchorSide;
	endSide: AnchorSide;
} {
	const sourcePadding = SOURCE_CONNECTOR_PADDING;
	const targetPadding = TARGET_CONNECTOR_PADDING;
	const connection = chooseConnection(
		firstAnchor,
		secondAnchor,
		firstLaneOffset,
		secondLaneOffset,
		sourcePadding,
		targetPadding,
	);
	const minX = bounds ? 2 : Number.NEGATIVE_INFINITY;
	const maxX = bounds ? bounds.width - 2 : Number.POSITIVE_INFINITY;
	const minY = bounds ? 2 : Number.NEGATIVE_INFINITY;
	const maxY = bounds ? bounds.height - 2 : Number.POSITIVE_INFINITY;
	const startX = clamp(connection.start.x, minX, maxX);
	const startY = clamp(connection.start.y, minY, maxY);
	const endX = clamp(connection.end.x, minX, maxX);
	const endY = clamp(connection.end.y, minY, maxY);
	const delta = { x: endX - startX, y: endY - startY };
	const distance = Math.hypot(delta.x, delta.y);
	const curvePull = clamp(distance * 0.35, 42, 220);
	const sourceNormal = SIDE_NORMALS[connection.start.side];
	const targetNormal = SIDE_NORMALS[connection.end.side];
	const controlPoint1X = clamp(startX + sourceNormal.x * curvePull, minX, maxX);
	const controlPoint1Y = clamp(startY + sourceNormal.y * curvePull, minY, maxY);
	const controlPoint2X = clamp(endX + targetNormal.x * curvePull, minX, maxX);
	const controlPoint2Y = clamp(endY + targetNormal.y * curvePull, minY, maxY);

	const midpoint = cubicPoint(
		0.5,
		startX,
		startY,
		controlPoint1X,
		controlPoint1Y,
		controlPoint2X,
		controlPoint2Y,
		endX,
		endY,
	);

	const geometry: DependencyGeometry = {
		startX,
		startY,
		controlPoint1X,
		controlPoint1Y,
		controlPoint2X,
		controlPoint2Y,
		endX,
		endY,
		midpointX: midpoint.x,
		midpointY: midpoint.y,
		startSide: connection.start.side,
		endSide: connection.end.side,
	};
	return {
		geometry,
		path: buildPathFromGeometry(geometry),
		midpointX: midpoint.x,
		midpointY: midpoint.y,
		startSide: connection.start.side,
		endSide: connection.end.side,
	};
}

function hasComparableValueDifference(a: number, b: number): boolean {
	return Math.abs(a - b) > 0.5;
}

export function areLayoutsEqual(a: DependencyLayout, b: DependencyLayout): boolean {
	if (hasComparableValueDifference(a.width, b.width) || hasComparableValueDifference(a.height, b.height)) {
		return false;
	}
	const aKeys = Object.keys(a.anchors);
	const bKeys = Object.keys(b.anchors);
	if (aKeys.length !== bKeys.length) {
		return false;
	}
	for (const key of aKeys) {
		const aAnchor = a.anchors[key];
		const bAnchor = b.anchors[key];
		if (!aAnchor || !bAnchor) {
			return false;
		}
		if (
			hasComparableValueDifference(aAnchor.left, bAnchor.left) ||
			hasComparableValueDifference(aAnchor.right, bAnchor.right) ||
			hasComparableValueDifference(aAnchor.top, bAnchor.top) ||
			hasComparableValueDifference(aAnchor.bottom, bAnchor.bottom) ||
			aAnchor.columnId !== bAnchor.columnId
		) {
			return false;
		}
	}
	return true;
}

export function createEmptyLayout(): DependencyLayout {
	return {
		width: 0,
		height: 0,
		anchors: {},
	};
}
