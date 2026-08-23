import { describe, expect, it } from "vitest";

import { _testing } from "../../../src/commands/diagnostics";

describe("diagnostics command parsing", () => {
	it("parses bounded duration units", () => {
		expect(_testing.parseDuration("250ms", 1_000)).toBe(250);
		expect(_testing.parseDuration("1.5s", 2_000)).toBe(1_500);
		expect(_testing.parseDuration("2m", 180_000)).toBe(120_000);
		expect(() => _testing.parseDuration("1h", 15 * 60_000)).toThrow("Duration must be between");
		expect(() => _testing.parseDuration("20", 60_000)).toThrow("Invalid duration");
	});

	it("validates source and level filters rather than silently ignoring mistakes", () => {
		expect(_testing.buildFilter({ source: "browser", level: "warn", project: "p1" })).toMatchObject({
			source: "browser",
			level: "warn",
			projectId: "p1",
		});
		expect(() => _testing.buildFilter({ source: "browzer" })).toThrow("Invalid diagnostic source");
		expect(() => _testing.buildFilter({ level: "warning" })).toThrow("Invalid diagnostic level");
	});

	it("matches correlation and prefix filters", () => {
		const record = {
			version: 1 as const,
			id: "runtime:1",
			sequence: 1,
			timestamp: 1_000,
			monotonicOffsetMs: 1,
			runtimeInstanceId: "runtime",
			source: "runtime" as const,
			kind: "event" as const,
			level: "warn" as const,
			name: "terminal.restore.failed",
			context: { projectId: "p1", taskId: "t1", operationId: "o1" },
			payload: {},
		};
		expect(_testing.matchesFilter(record, { projectId: "p1", name: "terminal.restore" })).toBe(true);
		expect(_testing.matchesFilter(record, { taskId: "other" })).toBe(false);
	});
});
