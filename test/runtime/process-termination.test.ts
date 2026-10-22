import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		// Heavy machine load can slow a trivial child's fork/exec well past a
		// fixed guess, which would otherwise race the probe's own deadline and
		// have it kill a child that was merely slow, not hung. Block on a marker
		// the child writes right before it exits (bounded generously) instead of
		// assuming a fixed duration always outlasts the child's real exit.
		const markerDir = mkdtempSync(join(tmpdir(), "qd-stall-marker-"));
		const marker = join(markerDir, "exited");
		try {
			const resultPromise = new Promise<boolean>((resolve) => {
				const child = execFile(
					process.execPath,
					["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, ""); process.exit(0);`],
					{},
					() => {
						resolve(guard.isTimedOut());
					},
				);
				const guard = armChildProcessTimeout(child, 150);
			});
			// Real event-loop stall: block the main thread synchronously until the
			// child has actually written its marker (bounded for heavy load), then
			// a fixed margin past that, before the exec callback or the probe's
			// own timer ever get a chance to run.
			const markerDeadline = Date.now() + 10_000;
			while (!existsSync(marker) && Date.now() < markerDeadline) {
				// busy-wait
			}
			const blockUntil = Date.now() + 300;
			while (Date.now() < blockUntil) {
				// busy-wait
			}
			expect(await resultPromise).toBe(false);
		} finally {
			rmSync(markerDir, { recursive: true, force: true });
		}
	}, 15_000);

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
		"releases pipes a descendant still holds after exit and reports the child's own result",
		async () => {
			// The direct child exits at once, but a detached descendant keeps its stdout open far past the grace period.
			const script = [
				"const { spawn } = require('node:child_process');",
				"const d = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000)'], {",
				"  stdio: 'inherit',",
				"  detached: true,",
				"});",
				"d.unref();",
				"process.stdout.write('child-output');",
				"process.exit(0);",
			].join(" ");
			const start = Date.now();
			const result = await new Promise<{ timedOut: boolean; stdout: string; elapsedMs: number }>((resolve) => {
				let guard: ChildProcessTimeoutGuard | null = null;
				const child = execFile(process.execPath, ["-e", script], {}, (_error, stdout) => {
					guard?.settle();
					resolve({
						timedOut: guard?.isTimedOut() ?? false,
						stdout: String(stdout),
						elapsedMs: Date.now() - start,
					});
				});
				// Arm only after exit so the timer always finds an exited child.
				child.once("exit", () => {
					guard = armChildProcessTimeout(child, 50, { closeGraceMs: 100 });
				});
			});
			expect(result).toMatchObject({ timedOut: false, stdout: "child-output" });
			expect(result.elapsedMs).toBeLessThan(4_000);
		},
		10_000,
	);
});

describe("armChildProcessTimeout escalation", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function createChild(exitCode: number | null = null) {
		return {
			pid: 4321,
			exitCode,
			signalCode: null,
			kill: vi.fn(() => true),
			stdout: { destroy: vi.fn() },
			stderr: { destroy: vi.fn() },
		};
	}

	it("terminates, force-kills, releases pipes, and finally abandons a child that never exits", async () => {
		vi.useFakeTimers();
		const child = createChild();
		const onAbandoned = vi.fn();
		const guard = armChildProcessTimeout(child, 100, {
			platform: "linux",
			killGraceMs: 200,
			closeGraceMs: 300,
			onAbandoned,
		});

		// Each step runs one fake millisecond after its timer: fake timers delay an
		// immediate scheduled during a tick by 1 ms.
		await vi.advanceTimersByTimeAsync(101);
		expect(guard.isTimedOut()).toBe(true);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		await vi.advanceTimersByTimeAsync(201);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(onAbandoned).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(301);
		expect(child.stdout.destroy).toHaveBeenCalled();
		expect(child.stderr.destroy).toHaveBeenCalled();
		await vi.runAllTimersAsync();
		expect(onAbandoned).toHaveBeenCalledTimes(1);
	});

	it("does not time out a child that already exited when a stalled timer fires", async () => {
		vi.useFakeTimers();
		const child = createChild(0);
		const onAbandoned = vi.fn();
		const guard = armChildProcessTimeout(child, 100, { platform: "linux", onAbandoned });
		await vi.runAllTimersAsync();
		expect(guard.isTimedOut()).toBe(false);
		expect(child.kill).not.toHaveBeenCalled();
		expect(child.stdout.destroy).toHaveBeenCalled();
		expect(onAbandoned).not.toHaveBeenCalled();
	});

	it("stops every step once settled", async () => {
		vi.useFakeTimers();
		const child = createChild();
		const onAbandoned = vi.fn();
		const guard = armChildProcessTimeout(child, 100, { platform: "linux", onAbandoned });
		await vi.advanceTimersByTimeAsync(101);
		guard.settle();
		await vi.runAllTimersAsync();
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.stdout.destroy).not.toHaveBeenCalled();
		expect(onAbandoned).not.toHaveBeenCalled();
	});
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
