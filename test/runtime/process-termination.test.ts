import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	armChildProcessTimeout,
	type ChildProcessTimeoutGuard,
	terminateProcessForTimeout,
	terminateProcessTree,
} from "../../src/core";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("armChildProcessTimeout against real child processes", () => {
	it("tolerates a real event-loop stall without reporting a false timeout", async () => {
		const settled = await new Promise<boolean>((resolve) => {
			const child = execFile(process.execPath, ["-e", "process.exit(0);"], {}, () => {
				resolve(guard.isTimedOut());
			});
			const guard = armChildProcessTimeout(child, 150);
		});
		// Real event-loop stall: the child exits almost immediately, but we only
		// read the settled result after blocking the main thread synchronously
		// well past the probe timeout.
		const blockUntil = Date.now() + 300;
		while (Date.now() < blockUntil) {
			// busy-wait
		}
		expect(settled).toBe(false);
	}, 10_000);

	it.runIf(process.platform !== "win32")(
		"terminates a real hung child and reports a timeout",
		async () => {
			const result = await new Promise<{ timedOut: boolean; signal: string | null }>((resolve) => {
				const child = execFile(process.execPath, ["-e", "setInterval(() => {}, 1_000);"], {}, (error) => {
					resolve({ timedOut: guard.isTimedOut(), signal: (error as { signal?: string })?.signal ?? null });
				});
				const guard = armChildProcessTimeout(child, 150);
			});
			expect(result).toMatchObject({ timedOut: true, signal: "SIGTERM" });
		},
		10_000,
	);

	it.runIf(process.platform !== "win32")(
		"reports a timeout after the close grace period when a descendant still holds stdio open",
		async () => {
			// The direct child exits at once, but a detached descendant keeps its stdout open past the grace period.
			const script = [
				"const { spawn } = require('node:child_process');",
				"const d = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 1000)'], {",
				"  stdio: 'inherit',",
				"  detached: true,",
				"});",
				"d.unref();",
				"process.exit(0);",
			].join(" ");
			const start = Date.now();
			const result = await new Promise<{ timedOut: boolean; elapsedMs: number }>((resolve) => {
				let guard: ChildProcessTimeoutGuard | null = null;
				const child = execFile(process.execPath, ["-e", script], {}, () => {
					resolve({ timedOut: guard?.isTimedOut() ?? false, elapsedMs: Date.now() - start });
				});
				// Arm only after exit so the timer always finds an exited child and takes the grace path.
				child.once("exit", () => {
					guard = armChildProcessTimeout(child, 50, { closeGraceMs: 100 });
				});
			});
			expect(result.timedOut).toBe(true);
			expect(result.elapsedMs).toBeGreaterThanOrEqual(150);
		},
		10_000,
	);
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
