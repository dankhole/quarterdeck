// @vitest-environment node

import { describe, expect, it } from "vitest";
import { TerminalWheelAccumulator } from "./terminal-wheel-policy";

function scroll(deltas: number[], deltaMode = 0, cellHeight = 10): number[] {
	const accumulator = new TerminalWheelAccumulator();
	return deltas.map((deltaY) => accumulator.consume({ deltaY, deltaMode }, cellHeight, 30));
}

describe("terminal wheel distance", () => {
	it("preserves the same distance across coalesced and fine-grained trackpad events", () => {
		expect(scroll([600])).toEqual([20]);
		expect(scroll(Array.from({ length: 100 }, () => 6)).reduce((sum, n) => sum + n, 0)).toBe(20);
	});
	it("has no sensitivity discontinuity at 50 pixels", () => {
		expect(scroll([49, 51, 50])).toEqual([1, 2, 2]);
	});
	it("preserves distance after Chromium float32 delta conversion", () => {
		expect(
			scroll(
				Array.from({ length: 30 }, () => Math.fround(10.2)),
				0,
				17,
			).reduce((sum, n) => sum + n, 0),
		).toBe(6);
	});
	it("accumulates small deltas and reverses without consuming the opposite remainder", () => {
		expect(scroll([20, -10, -20])).toEqual([0, 0, -1]);
	});
	it("uses browser line and page units", () => {
		expect(scroll([3, -6], 1)).toEqual([1, -2]);
		expect(scroll([1, -1], 2)).toEqual([10, -10]);
	});
	it("uses CSS row height so display scaling does not change distance", () => {
		expect(scroll([120], 0, 20)).toEqual([2]);
	});
	it.each([8, 300, 10_000])("preserves one-line ticks spaced %i ms apart", (gap) => {
		const accumulator = new TerminalWheelAccumulator();
		const events = Array.from({ length: 9 }, (_, index) => ({
			deltaY: 1,
			deltaMode: 1,
			timeStamp: index * gap,
		}));
		expect(events.map((event) => accumulator.consume(event, 10, 30))).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
	});
	it("preserves small pixel movements across a pause", () => {
		const accumulator = new TerminalWheelAccumulator();
		const events = [
			{ deltaY: 20, deltaMode: 0, timeStamp: 0 },
			{ deltaY: 10, deltaMode: 0, timeStamp: 300 },
		];
		expect(events.map((event) => accumulator.consume(event, 10, 30))).toEqual([0, 1]);
	});
	it("drops fractional motion on explicit reset", () => {
		const accumulator = new TerminalWheelAccumulator();
		expect(accumulator.consume({ deltaY: 20, deltaMode: 0 }, 10, 30)).toBe(0);
		accumulator.reset();
		expect(accumulator.consume({ deltaY: 10, deltaMode: 0 }, 10, 30)).toBe(0);
	});
	it("bounds pathological input without retaining a delayed scroll backlog", () => {
		expect(scroll([Infinity, NaN, 1e9, 30])).toEqual([0, 0, 100, 1]);
	});
});
