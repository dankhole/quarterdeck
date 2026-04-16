import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetLoggerForTests,
	createTaggedLogger,
	getLogLevel,
	getRecentLogEntries,
	isDebugLoggingEnabled,
	onLogEntry,
	setDebugLoggingEnabled,
	setLogLevel,
} from "../../src/core/runtime-logger";

describe("runtime-logger", () => {
	beforeEach(() => {
		_resetLoggerForTests();
	});

	afterEach(() => {
		_resetLoggerForTests();
		vi.restoreAllMocks();
	});

	describe("log level", () => {
		it("defaults to warn", () => {
			expect(getLogLevel()).toBe("warn");
		});

		it("can be set to any level", () => {
			setLogLevel("debug");
			expect(getLogLevel()).toBe("debug");
			setLogLevel("info");
			expect(getLogLevel()).toBe("info");
			setLogLevel("error");
			expect(getLogLevel()).toBe("error");
		});
	});

	describe("enable / disable (legacy API)", () => {
		it("starts disabled", () => {
			expect(isDebugLoggingEnabled()).toBe(false);
		});

		it("setDebugLoggingEnabled(true) sets level to debug", () => {
			setDebugLoggingEnabled(true);
			expect(isDebugLoggingEnabled()).toBe(true);
			expect(getLogLevel()).toBe("debug");
		});

		it("setDebugLoggingEnabled(false) sets level to warn", () => {
			setDebugLoggingEnabled(true);
			setDebugLoggingEnabled(false);
			expect(isDebugLoggingEnabled()).toBe(false);
			expect(getLogLevel()).toBe("warn");
		});

		it("isDebugLoggingEnabled returns true for debug and info levels", () => {
			setLogLevel("debug");
			expect(isDebugLoggingEnabled()).toBe(true);
			setLogLevel("info");
			expect(isDebugLoggingEnabled()).toBe(true);
			setLogLevel("warn");
			expect(isDebugLoggingEnabled()).toBe(false);
			setLogLevel("error");
			expect(isDebugLoggingEnabled()).toBe(false);
		});
	});

	describe("emit gating by level", () => {
		beforeEach(() => {
			vi.spyOn(console, "debug").mockImplementation(() => {});
			vi.spyOn(console, "info").mockImplementation(() => {});
			vi.spyOn(console, "warn").mockImplementation(() => {});
			vi.spyOn(console, "error").mockImplementation(() => {});
		});

		it("at warn level: only warn and error are emitted", () => {
			setLogLevel("warn");
			const log = createTaggedLogger("test");
			log.debug("d");
			log.info("i");
			log.warn("w");
			log.error("e");
			const levels = getRecentLogEntries().map((e) => e.level);
			expect(levels).toEqual(["warn", "error"]);
		});

		it("at info level: info, warn, error are emitted", () => {
			setLogLevel("info");
			const log = createTaggedLogger("test");
			log.debug("d");
			log.info("i");
			log.warn("w");
			log.error("e");
			const levels = getRecentLogEntries().map((e) => e.level);
			expect(levels).toEqual(["info", "warn", "error"]);
		});

		it("at debug level: all levels are emitted", () => {
			setLogLevel("debug");
			const log = createTaggedLogger("test");
			log.debug("d");
			log.info("i");
			log.warn("w");
			log.error("e");
			const levels = getRecentLogEntries().map((e) => e.level);
			expect(levels).toEqual(["debug", "info", "warn", "error"]);
		});

		it("at error level: only error is emitted", () => {
			setLogLevel("error");
			const log = createTaggedLogger("test");
			log.debug("d");
			log.info("i");
			log.warn("w");
			log.error("e");
			const levels = getRecentLogEntries().map((e) => e.level);
			expect(levels).toEqual(["error"]);
		});

		it("does not record entries when below threshold", () => {
			setLogLevel("warn");
			const log = createTaggedLogger("test");
			log.debug("should be ignored");
			log.info("should be ignored");
			expect(getRecentLogEntries()).toHaveLength(0);
		});
	});

	describe("emit (enabled)", () => {
		beforeEach(() => {
			setLogLevel("debug");
			vi.spyOn(console, "debug").mockImplementation(() => {});
			vi.spyOn(console, "info").mockImplementation(() => {});
			vi.spyOn(console, "warn").mockImplementation(() => {});
			vi.spyOn(console, "error").mockImplementation(() => {});
		});

		it("records entries to ring buffer", () => {
			const log = createTaggedLogger("mytag");
			log.info("hello");
			const entries = getRecentLogEntries();
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
			const entries = getRecentLogEntries();
			expect(entries[0]?.id).toBe("1");
			expect(entries[1]?.id).toBe("2");
		});

		it("supports all four log levels", () => {
			const log = createTaggedLogger("t");
			log.debug("d");
			log.info("i");
			log.warn("w");
			log.error("e");
			const levels = getRecentLogEntries().map((e) => e.level);
			expect(levels).toEqual(["debug", "info", "warn", "error"]);
		});

		it("writes to console with timestamp and tag prefix", () => {
			const log = createTaggedLogger("srv");
			log.warn("something");
			expect(console.warn).toHaveBeenCalledWith(
				expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] \[srv\]$/),
				"something",
			);
		});

		it("writes to console with data when provided", () => {
			const log = createTaggedLogger("srv");
			const data = { key: "val" };
			log.info("msg", data);
			expect(console.info).toHaveBeenCalledWith(
				expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] \[srv\]$/),
				"msg",
				data,
			);
		});

		it("stores data in entry", () => {
			const log = createTaggedLogger("t");
			log.debug("m", { x: 1 });
			expect(getRecentLogEntries()[0]?.data).toEqual({ x: 1 });
		});

		it("stores undefined data as undefined", () => {
			const log = createTaggedLogger("t");
			log.debug("m");
			expect(getRecentLogEntries()[0]?.data).toBeUndefined();
		});
	});

	describe("ring buffer overflow", () => {
		beforeEach(() => {
			setLogLevel("debug");
			vi.spyOn(console, "debug").mockImplementation(() => {});
		});

		it("evicts oldest entries when capacity exceeded", () => {
			const log = createTaggedLogger("t");
			for (let i = 0; i < 210; i++) {
				log.debug(`msg-${i}`);
			}
			const entries = getRecentLogEntries();
			expect(entries).toHaveLength(200);
			expect(entries[0]?.message).toBe("msg-10");
			expect(entries[199]?.message).toBe("msg-209");
		});
	});

	describe("listeners", () => {
		beforeEach(() => {
			setLogLevel("debug");
			vi.spyOn(console, "debug").mockImplementation(() => {});
		});

		it("notifies registered listener on each entry", () => {
			const received: unknown[] = [];
			onLogEntry((entry) => received.push(entry));
			const log = createTaggedLogger("t");
			log.debug("a");
			log.debug("b");
			expect(received).toHaveLength(2);
		});

		it("unsubscribe stops notifications", () => {
			const received: unknown[] = [];
			const unsubscribe = onLogEntry((entry) => received.push(entry));
			const log = createTaggedLogger("t");
			log.debug("a");
			unsubscribe();
			log.debug("b");
			expect(received).toHaveLength(1);
		});

		it("listener errors do not break logging", () => {
			onLogEntry(() => {
				throw new Error("boom");
			});
			const received: unknown[] = [];
			onLogEntry((entry) => received.push(entry));

			const log = createTaggedLogger("t");
			log.debug("still works");

			expect(received).toHaveLength(1);
			expect(getRecentLogEntries()).toHaveLength(1);
		});
	});

	describe("safeSerializeData", () => {
		beforeEach(() => {
			setLogLevel("debug");
			vi.spyOn(console, "debug").mockImplementation(() => {});
		});

		it("handles null data", () => {
			const log = createTaggedLogger("t");
			log.debug("m", null);
			expect(getRecentLogEntries()[0]?.data).toBeNull();
		});

		it("truncates oversized data or falls back to String()", () => {
			const log = createTaggedLogger("t");
			const bigString = "x".repeat(3000);
			log.debug("m", bigString);
			const entry = getRecentLogEntries()[0];
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
			const entry = getRecentLogEntries()[0];
			expect(typeof entry?.data).toBe("string");
		});
	});

	describe("getRecentLogEntries", () => {
		beforeEach(() => {
			setLogLevel("debug");
			vi.spyOn(console, "debug").mockImplementation(() => {});
		});

		it("returns a defensive copy", () => {
			const log = createTaggedLogger("t");
			log.debug("a");
			const entries1 = getRecentLogEntries();
			const entries2 = getRecentLogEntries();
			expect(entries1).not.toBe(entries2);
			expect(entries1).toEqual(entries2);
		});
	});
});
