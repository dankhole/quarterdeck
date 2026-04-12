import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetDebugLoggerForTests,
	createTaggedLogger,
	getRecentDebugLogEntries,
	isDebugLoggingEnabled,
	onDebugLogEntry,
	setDebugLoggingEnabled,
} from "../../src/core/debug-logger";

describe("debug-logger", () => {
	beforeEach(() => {
		_resetDebugLoggerForTests();
	});

	afterEach(() => {
		_resetDebugLoggerForTests();
		vi.restoreAllMocks();
	});

	describe("enable / disable", () => {
		it("starts disabled", () => {
			expect(isDebugLoggingEnabled()).toBe(false);
		});

		it("can be enabled and disabled", () => {
			setDebugLoggingEnabled(true);
			expect(isDebugLoggingEnabled()).toBe(true);
			setDebugLoggingEnabled(false);
			expect(isDebugLoggingEnabled()).toBe(false);
		});
	});

	describe("emit (no-op when disabled)", () => {
		it("does not record entries when disabled", () => {
			const log = createTaggedLogger("test");
			log.debug("should be ignored");
			expect(getRecentDebugLogEntries()).toHaveLength(0);
		});
	});

	describe("emit (enabled)", () => {
		beforeEach(() => {
			setDebugLoggingEnabled(true);
			vi.spyOn(console, "debug").mockImplementation(() => {});
			vi.spyOn(console, "info").mockImplementation(() => {});
			vi.spyOn(console, "warn").mockImplementation(() => {});
			vi.spyOn(console, "error").mockImplementation(() => {});
		});

		it("records entries to ring buffer", () => {
			const log = createTaggedLogger("mytag");
			log.info("hello");
			const entries = getRecentDebugLogEntries();
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				level: "info",
				tag: "mytag",
				message: "hello",
				source: "server",
			});
		});

		it("assigns sequential ids starting from 1", () => {
			const log = createTaggedLogger("t");
			log.debug("a");
			log.debug("b");
			const entries = getRecentDebugLogEntries();
			expect(entries[0]?.id).toBe("1");
			expect(entries[1]?.id).toBe("2");
		});

		it("supports all four log levels", () => {
			const log = createTaggedLogger("t");
			log.debug("d");
			log.info("i");
			log.warn("w");
			log.error("e");
			const levels = getRecentDebugLogEntries().map((e) => e.level);
			expect(levels).toEqual(["debug", "info", "warn", "error"]);
		});

		it("writes to console with tag prefix", () => {
			const log = createTaggedLogger("srv");
			log.warn("something");
			expect(console.warn).toHaveBeenCalledWith("[srv]", "something");
		});

		it("writes to console with data when provided", () => {
			const log = createTaggedLogger("srv");
			const data = { key: "val" };
			log.info("msg", data);
			expect(console.info).toHaveBeenCalledWith("[srv]", "msg", data);
		});

		it("stores data in entry", () => {
			const log = createTaggedLogger("t");
			log.debug("m", { x: 1 });
			expect(getRecentDebugLogEntries()[0]?.data).toEqual({ x: 1 });
		});

		it("stores undefined data as undefined", () => {
			const log = createTaggedLogger("t");
			log.debug("m");
			expect(getRecentDebugLogEntries()[0]?.data).toBeUndefined();
		});
	});

	describe("ring buffer overflow", () => {
		beforeEach(() => {
			setDebugLoggingEnabled(true);
			vi.spyOn(console, "debug").mockImplementation(() => {});
		});

		it("evicts oldest entries when capacity exceeded", () => {
			const log = createTaggedLogger("t");
			for (let i = 0; i < 210; i++) {
				log.debug(`msg-${i}`);
			}
			const entries = getRecentDebugLogEntries();
			expect(entries).toHaveLength(200);
			expect(entries[0]?.message).toBe("msg-10");
			expect(entries[199]?.message).toBe("msg-209");
		});
	});

	describe("listeners", () => {
		beforeEach(() => {
			setDebugLoggingEnabled(true);
			vi.spyOn(console, "debug").mockImplementation(() => {});
		});

		it("notifies registered listener on each entry", () => {
			const received: unknown[] = [];
			onDebugLogEntry((entry) => received.push(entry));
			const log = createTaggedLogger("t");
			log.debug("a");
			log.debug("b");
			expect(received).toHaveLength(2);
		});

		it("unsubscribe stops notifications", () => {
			const received: unknown[] = [];
			const unsubscribe = onDebugLogEntry((entry) => received.push(entry));
			const log = createTaggedLogger("t");
			log.debug("a");
			unsubscribe();
			log.debug("b");
			expect(received).toHaveLength(1);
		});

		it("listener errors do not break logging", () => {
			onDebugLogEntry(() => {
				throw new Error("boom");
			});
			const received: unknown[] = [];
			onDebugLogEntry((entry) => received.push(entry));

			const log = createTaggedLogger("t");
			log.debug("still works");

			expect(received).toHaveLength(1);
			expect(getRecentDebugLogEntries()).toHaveLength(1);
		});
	});

	describe("safeSerializeData", () => {
		beforeEach(() => {
			setDebugLoggingEnabled(true);
			vi.spyOn(console, "debug").mockImplementation(() => {});
		});

		it("handles null data", () => {
			const log = createTaggedLogger("t");
			log.debug("m", null);
			expect(getRecentDebugLogEntries()[0]?.data).toBeNull();
		});

		it("truncates oversized data or falls back to String()", () => {
			const log = createTaggedLogger("t");
			const bigString = "x".repeat(3000);
			log.debug("m", bigString);
			const entry = getRecentDebugLogEntries()[0];
			// safeSerializeData truncates the JSON, which may produce invalid JSON.
			// JSON.parse on truncated JSON throws, so it falls back to String(data).
			// Either way, the stored data should be shorter than the original.
			const stored = typeof entry?.data === "string" ? entry.data : JSON.stringify(entry?.data);
			expect(stored?.length).toBeLessThan(JSON.stringify(bigString).length);
		});

		it("falls back to String() for circular references", () => {
			const log = createTaggedLogger("t");
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			log.debug("m", circular);
			const entry = getRecentDebugLogEntries()[0];
			expect(typeof entry?.data).toBe("string");
		});
	});

	describe("getRecentDebugLogEntries", () => {
		beforeEach(() => {
			setDebugLoggingEnabled(true);
			vi.spyOn(console, "debug").mockImplementation(() => {});
		});

		it("returns a defensive copy", () => {
			const log = createTaggedLogger("t");
			log.debug("a");
			const entries1 = getRecentDebugLogEntries();
			const entries2 = getRecentDebugLogEntries();
			expect(entries1).not.toBe(entries2);
			expect(entries1).toEqual(entries2);
		});
	});
});
