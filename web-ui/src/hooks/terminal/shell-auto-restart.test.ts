import { describe, expect, it } from "vitest";
import {
	canRestart,
	MAX_RESTARTS,
	parseRestartTarget,
	RATE_LIMIT_WINDOW_MS,
	RESTART_DELAY_MS,
	recordRestart,
} from "@/hooks/terminal/shell-auto-restart";

describe("parseRestartTarget", () => {
	it("returns home for HOME_TERMINAL_TASK_ID", () => {
		expect(parseRestartTarget("__home_terminal__")).toEqual({ type: "home" });
	});

	it("returns detail with cardId for detail terminal prefix", () => {
		expect(parseRestartTarget("__detail_terminal__:abc-123")).toEqual({ type: "detail", cardId: "abc-123" });
	});

	it("returns null for detail prefix with empty cardId", () => {
		expect(parseRestartTarget("__detail_terminal__:")).toBeNull();
	});

	it("returns null for regular task IDs", () => {
		expect(parseRestartTarget("task-123")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseRestartTarget("")).toBeNull();
	});
});

describe("canRestart", () => {
	const now = 100_000;

	it("allows restart with no history", () => {
		expect(canRestart([], now)).toBe(true);
	});

	it("allows restart with fewer than MAX_RESTARTS recent timestamps", () => {
		const timestamps = [now - 1000, now - 2000];
		expect(canRestart(timestamps, now)).toBe(true);
	});

	it("blocks restart at MAX_RESTARTS within window", () => {
		const timestamps = Array.from({ length: MAX_RESTARTS }, (_, i) => now - i * 1000);
		expect(canRestart(timestamps, now)).toBe(false);
	});

	it("ignores timestamps outside the rate limit window", () => {
		const timestamps = Array.from({ length: MAX_RESTARTS }, (_, i) => now - RATE_LIMIT_WINDOW_MS - i * 1000);
		expect(canRestart(timestamps, now)).toBe(true);
	});
});

describe("recordRestart", () => {
	const now = 100_000;

	it("adds timestamp and returns pruned list", () => {
		const result = recordRestart([now - 1000], now);
		expect(result).toEqual([now - 1000, now]);
	});

	it("prunes old timestamps outside the window", () => {
		const old = now - RATE_LIMIT_WINDOW_MS - 1;
		const result = recordRestart([old, now - 1000], now);
		expect(result).toEqual([now - 1000, now]);
	});

	it("works with empty history", () => {
		const result = recordRestart([], now);
		expect(result).toEqual([now]);
	});
});

describe("constants", () => {
	it("has expected values", () => {
		expect(MAX_RESTARTS).toBe(3);
		expect(RATE_LIMIT_WINDOW_MS).toBe(30_000);
		expect(RESTART_DELAY_MS).toBe(1000);
	});
});
