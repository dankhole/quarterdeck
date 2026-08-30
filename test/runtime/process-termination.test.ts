import { afterEach, describe, expect, it, vi } from "vitest";

import { terminateProcessForTimeout, terminateProcessTree } from "../../src/core";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("terminateProcessTree", () => {
	it.runIf(process.platform !== "win32")("signals a detached POSIX process group", () => {
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const callback = vi.fn();

		terminateProcessTree(456, "SIGTERM", callback);

		expect(kill).toHaveBeenCalledWith(-456, "SIGTERM");
		expect(callback).toHaveBeenCalledWith();
	});

	it("rejects invalid process ids without signalling", () => {
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const callback = vi.fn();

		terminateProcessTree(0, "SIGTERM", callback);

		expect(kill).not.toHaveBeenCalled();
		expect(callback).toHaveBeenCalledWith(expect.any(Error));
	});
});

describe("terminateProcessForTimeout", () => {
	it("uses SIGTERM on non-windows platforms", () => {
		const kill = vi.fn(() => true);
		const killProcessTree = vi.fn();

		terminateProcessForTimeout(
			{
				pid: 123,
				kill,
			},
			{
				platform: "linux",
				killProcessTree,
			},
		);

		expect(kill).toHaveBeenCalledWith("SIGTERM");
		expect(killProcessTree).not.toHaveBeenCalled();
	});

	it("preserves the root until taskkill captures its Windows process tree", () => {
		const kill = vi.fn(() => true);
		const killProcessTree = vi.fn((_pid: number, _signal?: string | number, callback?: (error?: Error) => void) =>
			callback?.(),
		);

		terminateProcessForTimeout(
			{
				pid: 456,
				kill,
			},
			{
				platform: "win32",
				killProcessTree,
			},
		);

		expect(kill).not.toHaveBeenCalled();
		expect(killProcessTree).toHaveBeenCalledWith(456, "SIGTERM", expect.any(Function));
	});

	it("falls back to an exact-root kill when Windows tree termination fails", () => {
		const kill = vi.fn(() => true);
		const killProcessTree = vi.fn((_pid: number, _signal?: string | number, callback?: (error?: Error) => void) =>
			callback?.(new Error("taskkill failed")),
		);

		terminateProcessForTimeout({ pid: 456, kill }, { platform: "win32", killProcessTree });

		expect(kill).toHaveBeenCalledWith();
	});

	it("skips taskkill tree when pid is missing on windows", () => {
		const kill = vi.fn(() => true);
		const killProcessTree = vi.fn();

		terminateProcessForTimeout(
			{
				kill,
			},
			{
				platform: "win32",
				killProcessTree,
			},
		);

		expect(kill).toHaveBeenCalledWith();
		expect(killProcessTree).not.toHaveBeenCalled();
	});
});
