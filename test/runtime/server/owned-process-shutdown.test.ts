import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeOwnedProcessShutdown,
	stopRuntimeOwnedProcessTrees,
} from "../../../src/server/owned-process-shutdown.js";
import type { OwnedProcessSnapshot } from "../../../src/server/owned-process-snapshot.js";

function row(pid: number, parentPid: number, creationIdentity = String(pid)): OwnedProcessSnapshot {
	return { pid, parentPid, creationIdentity, preciseIdentity: true, zombie: false };
}

describe("exact-owned process shutdown", () => {
	it("shares in-flight cleanup and caches only confirmed termination", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const snapshot = vi.fn(async () => {
			await gate;
			return [];
		});
		const stopSessions = vi.fn();
		const shutdown = createRuntimeOwnedProcessShutdown({ getRootPids: () => [], snapshot });
		const first = shutdown(stopSessions);
		expect(shutdown(stopSessions)).toBe(first);
		release();
		expect(await first).toEqual({ status: "stopped" });
		expect(await shutdown(stopSessions)).toEqual({ status: "stopped" });
		expect(snapshot).toHaveBeenCalledTimes(2);
		expect(stopSessions).toHaveBeenCalledOnce();
	});

	it("keeps BSD parents alive until TERM-resistant descendants are confirmed stopped", async () => {
		vi.useFakeTimers();
		try {
			let rows = [row(11, 10), row(10, 1)].map((entry) => ({ ...entry, preciseIdentity: false }));
			const signals: Array<[number, string]> = [];
			const stopping = stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [10],
				stopSessions: () => {},
				snapshot: async () => [...rows],
				graceMs: 1,
				signal: (pid, name) => {
					signals.push([pid, name]);
					if (pid === 10) expect(rows.some((entry) => entry.pid === 11)).toBe(false);
					if (pid === 10 || name === "SIGKILL") rows = rows.filter((entry) => entry.pid !== pid);
				},
			});
			await vi.runAllTimersAsync();
			expect(await stopping).toEqual({ status: "stopped" });
			expect(signals).toEqual([
				[11, "SIGTERM"],
				[11, "SIGKILL"],
				[10, "SIGKILL"],
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([false, true])(
		"retains orphaned identities across settled retries (precise=%s)",
		async (preciseIdentity) => {
			let rows = [row(10, 1), row(11, 10)].map((entry) => ({ ...entry, preciseIdentity }));
			let roots = [10];
			const signal = vi.fn();
			const shutdown = createRuntimeOwnedProcessShutdown({
				runtimePid: 1,
				getRootPids: () => roots,
				snapshot: async () => [...rows],
				signal,
				timeoutMs: 0,
			});
			expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
			// The parent exits independently and live session enumeration loses its root.
			roots = [];
			rows = [{ ...row(11, 99), preciseIdentity }];
			expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
			expect(signal.mock.calls.filter(([pid]) => pid === 11)).toHaveLength(preciseIdentity ? 2 : 1);
			rows = [];
			expect(await shutdown(() => {})).toEqual({ status: "stopped" });
		},
	);

	it("retains failed initial coverage with no terminal roots and a live orphaned helper", async () => {
		let fail = true;
		const signal = vi.fn();
		const shutdown = createRuntimeOwnedProcessShutdown({
			runtimePid: 1,
			getRootPids: () => [],
			includeRuntimeChildren: true,
			signal,
			snapshot: async () => {
				if (fail) throw new Error("synthetic snapshot failure");
				return [row(51, 99)];
			},
		});
		expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
		fail = false;
		expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
		expect(signal).not.toHaveBeenCalled();
	});

	it("cannot forget vanished original roots after initial snapshot failure", async () => {
		let roots = [10];
		let fail = true;
		const signal = vi.fn();
		const shutdown = createRuntimeOwnedProcessShutdown({
			runtimePid: 1,
			getRootPids: () => roots,
			signal,
			snapshot: async () => {
				if (fail) throw new Error("synthetic metadata failure");
				return [row(11, 99)];
			},
		});
		expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
		fail = false;
		roots = [];
		expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
		expect(signal).not.toHaveBeenCalled();
	});

	it("retains coverage gaps across retries instead of re-snapshotting an empty forest", async () => {
		let rows = [row(10, 99)];
		let roots = [10];
		const shutdown = createRuntimeOwnedProcessShutdown({
			runtimePid: 1,
			getRootPids: () => roots,
			snapshot: async () => rows,
			signal: vi.fn(),
		});
		expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
		rows = [];
		roots = [];
		expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
	});

	it("retries metadata failure against captured targets and refuses recycled identities", async () => {
		let queries = 0;
		let failObservation = true;
		const signal = vi.fn();
		const shutdown = createRuntimeOwnedProcessShutdown({
			runtimePid: 1,
			getRootPids: () => [10],
			signal,
			snapshot: async () => {
				if (++queries === 1) return [row(10, 1, "original")];
				if (failObservation) throw new Error("synthetic snapshot error");
				return [row(10, 1, "replacement")];
			},
		});
		expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
		failObservation = false;
		expect(await shutdown(() => {})).toEqual({ status: "stopped" });
		expect(signal).not.toHaveBeenCalled();
	});

	it("reports bounded content-free blockers once per incomplete attempt", async () => {
		const onUnconfirmed = vi.fn();
		const rows = Array.from({ length: 25 }, (_, index) => row(index + 10, 1, "private-birth-identity"));
		const shutdown = createRuntimeOwnedProcessShutdown({
			runtimePid: 1,
			getRootPids: () => rows.map((entry) => entry.pid),
			snapshot: async () => rows,
			signal: vi.fn(),
			timeoutMs: 0,
			onUnconfirmed,
		});
		expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
		expect(onUnconfirmed).toHaveBeenCalledOnce();
		const report = onUnconfirmed.mock.calls[0]?.[0];
		expect(report).toMatchObject({ reason: "deadline", targetCount: 25, blockerCount: 25, coverageUncertain: false });
		expect(report.blockers).toHaveLength(20);
		expect(report.blockers[0]).toEqual({
			pid: 10,
			parentPid: 1,
			observedParentPid: 1,
			identityPresent: true,
			preciseIdentity: true,
			reason: "still_live",
		});
		expect(JSON.stringify(report)).not.toContain("private-birth-identity");
	});

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

	it.each([false, true])(
		"clears temporary BSD reparenting without dismissing pending launch uncertainty (%s)",
		async (hasPendingLaunches) => {
			let queries = 0;
			const signal = vi.fn();
			expect(
				await stopRuntimeOwnedProcessTrees({
					runtimePid: 1,
					getRootPids: () => [10],
					hasPendingLaunches: () => hasPendingLaunches,
					stopSessions: () => {},
					signal,
					snapshot: async () => {
						queries++;
						if (queries === 1) return [row(10, 1), { ...row(11, 10), preciseIdentity: false }];
						if (queries === 2) return [{ ...row(11, 99), preciseIdentity: false }];
						return [];
					},
				}),
			).toEqual({ status: hasPendingLaunches ? "unconfirmed" : "stopped" });
			expect(queries).toBe(3);
			expect(signal).not.toHaveBeenCalled();
		},
	);

	it("retains uncertainty for new descendants of a reparented BSD process", async () => {
		let queries = 0;
		const signal = vi.fn();
		const coarseRow = (pid: number, parentPid: number) => ({ ...row(pid, parentPid), preciseIdentity: false });
		expect(
			await stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [10],
				stopSessions: () => {},
				signal,
				snapshot: async () => {
					queries++;
					if (queries === 1) return [coarseRow(10, 1), coarseRow(11, 10)];
					if (queries === 2) return [coarseRow(11, 99), coarseRow(12, 11)];
					return [coarseRow(12, 99)];
				},
			}),
		).toEqual({ status: "unconfirmed" });
		expect(queries).toBe(3);
		expect(signal).not.toHaveBeenCalled();
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
