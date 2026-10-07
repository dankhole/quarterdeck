import { describe, expect, it, vi } from "vitest";
import { stopRuntimeOwnedProcessTrees } from "../../../src/server/owned-process-shutdown.js";
import type { OwnedProcessSnapshot } from "../../../src/server/owned-process-snapshot.js";

function row(pid: number, parentPid: number, creationIdentity = String(pid)): OwnedProcessSnapshot {
	return { pid, parentPid, creationIdentity, preciseIdentity: true, zombie: false };
}

describe("exact-owned process shutdown", () => {
	it("captures descendants before lifecycle signalling and leaves unrelated roots untouched", async () => {
		let rows = [row(10, 1), row(11, 10), row(20, 1)];
		const stopSessions = vi.fn(() => {
			expect(snapshot).toHaveBeenCalledTimes(1);
		});
		const snapshot = vi.fn(async () => [...rows]);
		const signal = vi.fn((pid: number) => {
			rows = rows.filter((entry) => entry.pid !== pid);
		});
		expect(
			await stopRuntimeOwnedProcessTrees({ runtimePid: 1, getRootPids: () => [10], stopSessions, snapshot, signal }),
		).toEqual({ status: "stopped" });
		expect(signal.mock.calls.map(([pid]) => pid)).toEqual([11, 10]);
		expect(rows).toEqual([row(20, 1)]);
	});

	it("does not signal a recycled captured PID", async () => {
		const signal = vi.fn();
		let queries = 0;
		expect(
			await stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [10],
				stopSessions: () => {},
				signal,
				snapshot: async () => (++queries === 1 ? [row(10, 1, "old")] : [row(10, 1, "replacement")]),
			}),
		).toEqual({ status: "stopped" });
		expect(signal).not.toHaveBeenCalled();
	});

	it("fails closed on foreign ancestry and changing/pending launch roots", async () => {
		const signal = vi.fn();
		expect(
			await stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [10],
				hasPendingLaunches: () => true,
				stopSessions: () => {},
				signal,
				snapshot: async () => [row(10, 99)],
			}),
		).toEqual({ status: "unconfirmed" });
		expect(signal).not.toHaveBeenCalled();
	});

	it("still interrupts lifecycle when identity capture fails", async () => {
		const stopSessions = vi.fn();
		expect(
			await stopRuntimeOwnedProcessTrees({
				getRootPids: () => [10],
				stopSessions,
				snapshot: async () => {
					throw new Error("permission denied");
				},
			}),
		).toEqual({ status: "unconfirmed" });
		expect(stopSessions).toHaveBeenCalledOnce();
	});

	it("fails closed when verification fails after signalling", async () => {
		let queries = 0;
		const stopSessions = vi.fn();
		expect(
			await stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [10],
				stopSessions,
				snapshot: async () => {
					if (++queries === 1) return [row(10, 1)];
					throw new Error("process metadata unavailable");
				},
			}),
		).toEqual({ status: "unconfirmed" });
		expect(stopSessions).toHaveBeenCalledOnce();
	});

	it("preserves precise descendant ownership after root exit and reparenting", async () => {
		let queries = 0;
		let descendantLive = true;
		const signal = vi.fn((pid: number) => {
			if (pid === 11) descendantLive = false;
		});
		expect(
			await stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [10],
				stopSessions: () => {},
				signal,
				snapshot: async () => {
					if (++queries === 1) return [row(10, 1), row(11, 10)];
					return descendantLive ? [row(11, 99)] : [];
				},
			}),
		).toEqual({ status: "stopped" });
		expect(signal).toHaveBeenCalledWith(11, "SIGTERM");
	});

	it("cannot report stopped merely because signals were sent", async () => {
		const signal = vi.fn();
		expect(
			await stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [10],
				stopSessions: () => {},
				signal,
				graceMs: 0,
				timeoutMs: 0,
				snapshot: async () => [row(10, 1)],
			}),
		).toEqual({ status: "unconfirmed" });
		expect(signal).toHaveBeenCalledWith(10, "SIGKILL");
	});

	it("does not signal a BSD PID whose coarse birth time survives changed ancestry", async () => {
		let queries = 0;
		const signal = vi.fn();
		expect(
			await stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [10],
				stopSessions: () => {},
				signal,
				timeoutMs: 0,
				snapshot: async () => [
					{
						...row(10, ++queries === 1 ? 1 : 99),
						preciseIdentity: false,
					},
				],
			}),
		).toEqual({ status: "unconfirmed" });
		expect(signal).not.toHaveBeenCalled();
	});
});
