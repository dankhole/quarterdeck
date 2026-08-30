import { describe, expect, it } from "vitest";

import { getExitCodeForSignal, launchManagedProcess } from "../../scripts/dev-process.mjs";

describe("launchManagedProcess", () => {
	it("maps the Windows Ctrl+Break shutdown code deterministically", () => {
		expect(getExitCodeForSignal("SIGBREAK")).toBe(149);
	});

	it("requests graceful shutdown by closing the managed child's stdin", async () => {
		const managed = launchManagedProcess(
			process.execPath,
			[
				"-e",
				"process.stdin.resume(); process.stdin.on('end', () => { process.exitCode = 42; });",
			],
			{
				gracefulShutdownViaStdin: true,
				shutdownTimeoutMs: 5_000,
				stdio: ["ignore", "ignore", "ignore"],
			},
		);

		expect(managed.requestShutdown("SIGTERM")).toBe(true);
		expect(managed.requestShutdown("SIGTERM")).toBe(false);
		await expect(managed.exitPromise).resolves.toMatchObject({
			code: 42,
			signal: null,
			error: null,
		});
	});

	it("uses process-tree termination when a managed child exceeds its shutdown timeout", async () => {
		const terminatedPids = [];
		const managed = launchManagedProcess(
			process.execPath,
			["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
			{
				gracefulShutdownViaStdin: true,
				shutdownTimeoutMs: 10,
				stdio: ["ignore", "ignore", "ignore"],
				terminateProcessTree: (pid, signal, callback) => {
					terminatedPids.push({ pid, signal });
					try {
						process.kill(pid, "SIGKILL");
						callback?.();
					} catch (error) {
						callback?.(error);
					}
				},
			},
		);

		expect(managed.requestShutdown("SIGTERM")).toBe(true);
		await managed.exitPromise;
		expect(terminatedPids).toEqual([{ pid: managed.child.pid, signal: "SIGKILL" }]);
	});

	it("terminates a non-graceful managed child as a tree on the initial request", async () => {
		const terminatedPids = [];
		const managed = launchManagedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
			shutdownTimeoutMs: 5_000,
			stdio: ["ignore", "ignore", "ignore"],
			terminateProcessTree: (pid, signal, callback) => {
				terminatedPids.push({ pid, signal });
				try {
					process.kill(pid, "SIGKILL");
					callback?.();
				} catch (error) {
					callback?.(error);
				}
			},
		});

		expect(managed.requestShutdown("SIGTERM")).toBe(true);
		await managed.exitPromise;
		expect(terminatedPids).toEqual([{ pid: managed.child.pid, signal: "SIGTERM" }]);
	});
});
