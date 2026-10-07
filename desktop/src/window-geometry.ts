import type { Rectangle } from "electron";

export interface DesktopWindowState {
	version: 1;
	bounds: Rectangle;
	maximized: boolean;
	fullscreen: boolean;
}

export function parseWindowState(value: unknown): DesktopWindowState | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.maximized !== "boolean" || typeof record.fullscreen !== "boolean")
		return null;
	if (!record.bounds || typeof record.bounds !== "object" || Array.isArray(record.bounds)) return null;
	const bounds = record.bounds as Record<string, unknown>;
	if (
		!["x", "y", "width", "height"].every(
			(key) =>
				typeof bounds[key] === "number" && Number.isSafeInteger(bounds[key]) && Math.abs(bounds[key]) < 1_000_000,
		)
	)
		return null;
	if (Number(bounds.width) < 1 || Number(bounds.height) < 1) return null;
	return {
		version: 1,
		bounds: { x: Number(bounds.x), y: Number(bounds.y), width: Number(bounds.width), height: Number(bounds.height) },
		maximized: record.maximized,
		fullscreen: record.fullscreen,
	};
}

function intersectionArea(a: Rectangle, b: Rectangle): number {
	return (
		Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
		Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
	);
}

export function clampWindowBounds(saved: Rectangle, workAreas: readonly Rectangle[], primary: Rectangle): Rectangle {
	const display = workAreas.reduce<Rectangle>(
		(best, candidate) => (intersectionArea(saved, candidate) > intersectionArea(saved, best) ? candidate : best),
		primary,
	);
	const width = Math.min(display.width, Math.max(760, saved.width));
	const height = Math.min(display.height, Math.max(540, saved.height));
	return {
		x: Math.max(display.x, Math.min(saved.x, display.x + display.width - width)),
		y: Math.max(display.y, Math.min(saved.y, display.y + display.height - height)),
		width,
		height,
	};
}
