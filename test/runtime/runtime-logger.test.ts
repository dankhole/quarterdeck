import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	_resetLoggerForTests,
	createTaggedLogger,
	getLogLevel,
	type RuntimeDiagnosticLogSink,
	setLogLevel,
	setRuntimeDiagnosticLogSink,
} from "../../src/core";

type LogCandidate = Parameters<RuntimeDiagnosticLogSink["recordLog"]>[0];

describe("runtime-logger", () => {
	beforeEach(() => {
		_resetLoggerForTests();
		vi.spyOn(console, "debug").mockImplementation(() => undefined);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		_resetLoggerForTests();
		vi.restoreAllMocks();
	});

	it("defaults console verbosity to warn and accepts each level", () => {
		expect(getLogLevel()).toBe("warn");
		for (const level of ["debug", "info", "warn", "error"] as const) {
			setLogLevel(level);
			expect(getLogLevel()).toBe(level);
		}
	});

	it("applies the configured level only to console output", () => {
		setLogLevel("warn");
		const log = createTaggedLogger("test");
		log.debug("debug");
		log.info("info");
		log.warn("warn");
		log.error("error");

		expect(console.debug).not.toHaveBeenCalled();
		expect(console.info).not.toHaveBeenCalled();
		expect(console.warn).toHaveBeenCalledOnce();
		expect(console.error).toHaveBeenCalledOnce();
	});

	it("offers every candidate to the unified diagnostic sink independently of console verbosity", () => {
		const candidates: LogCandidate[] = [];
		setRuntimeDiagnosticLogSink({
			recordLog: (candidate) => {
				candidates.push(candidate);
			},
		});
		setLogLevel("error");
		const log = createTaggedLogger("subsystem");
		log.debug("detail", { count: 1 });
		log.info("started");
		log.warn("slow");
		log.error("failed");

		expect(candidates).toEqual([
			{ level: "debug", tag: "subsystem", message: "detail", data: { count: 1 } },
			{ level: "info", tag: "subsystem", message: "started", data: undefined },
			{ level: "warn", tag: "subsystem", message: "slow", data: undefined },
			{ level: "error", tag: "subsystem", message: "failed", data: undefined },
		]);
		expect(console.error).toHaveBeenCalledOnce();
		expect(console.debug).not.toHaveBeenCalled();
	});

	it("does not let a diagnostic sink failure break logging", () => {
		setRuntimeDiagnosticLogSink({
			recordLog: () => {
				throw new Error("recorder unavailable");
			},
		});
		const log = createTaggedLogger("test");
		expect(() => log.warn("still visible")).not.toThrow();
		expect(console.warn).toHaveBeenCalledOnce();
	});

	it("can detach the sink without retaining a second listener system", () => {
		const recordLog = vi.fn();
		setRuntimeDiagnosticLogSink({ recordLog });
		createTaggedLogger("test").warn("first");
		setRuntimeDiagnosticLogSink(null);
		createTaggedLogger("test").warn("second");
		expect(recordLog).toHaveBeenCalledOnce();
	});

	it("writes the original structured value to the console", () => {
		const data = { key: "value" };
		createTaggedLogger("server").warn("message", data);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] \[server\]$/),
			"message",
			data,
		);
	});
});
