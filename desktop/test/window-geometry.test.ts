import { describe, expect, it } from "vitest";
import { clampWindowBounds, parseWindowState } from "../src/window-geometry.js";

describe("desktop window restoration", () => {
	const primary = { x: 0, y: 25, width: 1440, height: 875 };
	const secondary = { x: -1920, y: 0, width: 1920, height: 1080 };

	it("keeps valid geometry on its surviving display", () => {
		const saved = { x: -1700, y: 100, width: 1280, height: 860 };
		expect(clampWindowBounds(saved, [primary, secondary], primary)).toEqual(saved);
	});

	it("moves a removed-display window completely into the primary work area", () => {
		expect(clampWindowBounds({ x: -1700, y: 100, width: 1800, height: 1000 }, [primary], primary)).toEqual({
			x: 0,
			y: 25,
			width: 1440,
			height: 875,
		});
	});

	it("clamps enlarged/minuscule windows and preserves negative display coordinates", () => {
		expect(
			clampWindowBounds({ x: -3000, y: -100, width: 3000, height: 2000 }, [primary, secondary], primary),
		).toEqual({ x: -1920, y: 0, width: 1920, height: 1080 });
		expect(clampWindowBounds({ x: 1400, y: 850, width: 20, height: 20 }, [primary], primary)).toEqual({
			x: 680,
			y: 360,
			width: 760,
			height: 540,
		});
	});

	it("ignores corrupt/nonfinite saved preferences", () => {
		const saved = {
			version: 1,
			bounds: { x: -1000, y: 10, width: 900, height: 700 },
			maximized: false,
			fullscreen: true,
		};
		expect(parseWindowState(saved)).toEqual(saved);
		for (const input of [
			null,
			{},
			{ ...saved, version: 2 },
			{ ...saved, bounds: { ...saved.bounds, x: Number.NaN } },
			{ ...saved, bounds: { ...saved.bounds, width: -1 } },
			{ ...saved, fullscreen: "yes" },
		])
			expect(parseWindowState(input)).toBeNull();
	});
});
