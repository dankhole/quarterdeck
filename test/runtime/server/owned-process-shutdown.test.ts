import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeOwnedProcessShutdown,
	stopRuntimeOwnedProcessTrees,
} from "../../../src/server/owned-process-shutdown.js";
import type { OwnedProcessSnapshot } from "../../../src/server/owned-process-snapshot.js";

function row(
	pid: number,
	parentPid: number,
	creationIdentity = String(pid),
	birth = BigInt(pid),
): OwnedProcessSnapshot {
	return {
		pid,
		parentPid,
		creationIdentity,
		birthTime: { clock: "windows", value: birth },
		preciseIdentity: true,
		zombie: false,
	};
}

function withRuntime(rows: readonly OwnedProcessSnapshot[]): OwnedProcessSnapshot[] {
	return [row(1, 0), ...rows];
}

describe("exact-owned process shutdown", () => {
	it.each([false, true])(
		"refuses an explicit root older than the runtime (include children=%s)",
		async (includeRuntimeChildren) => {
			const signal = vi.fn();
			const onUnconfirmed = vi.fn();
			const shutdown = createRuntimeOwnedProcessShutdown({
				runtimePid: 1,
				getRootPids: () => [10],
				includeRuntimeChildren,
				snapshot: async () => [row(1, 0, "runtime", 400n), row(10, 1, "old", 200n), row(11, 10, "child", 500n)],
				signal,
				onUnconfirmed,
			});
			expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
			expect(signal).not.toHaveBeenCalled();
			expect(onUnconfirmed.mock.calls[0]?.[0]).toMatchObject({ coverageUncertain: true, targetCount: 0 });
		},
	);

	it("ignores provably older automatic runtime children and their entire foreign subtree", async () => {
		let rows = [row(10, 1, "old", 200n), row(11, 10, "foreign-child", 500n), row(20, 1, "owned", 600n)];
		const signal = vi.fn((pid: number) => {
			rows = rows.filter((entry) => entry.pid !== pid);
		});
		expect(
			await stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [],
				includeRuntimeChildren: true,
				stopSessions: () => {},
				snapshot: async () => [row(1, 0, "runtime", 400n), ...rows],
				signal,
			}),
		).toEqual({ status: "stopped" });
		expect(signal.mock.calls.map(([pid]) => pid)).toEqual([20]);
		expect(rows.map((entry) => entry.pid)).toEqual([10, 11]);
	});

	it.each(["initial", "late"])("rejects older descendants at every %s ancestry edge", async (phase) => {
		const parent = row(10, 1, "owned", 638000000000000001n);
		const child = row(11, 10, "owned-child", 638000000000000002n);
		// A one-tick difference above Number's safe range must not round into equality.
		const foreign = row(12, 11, "foreign", 638000000000000001n);
		const foreignChild = row(13, 12, "foreign-child", 638000000000000003n);
		let rows = [parent, child, foreign, foreignChild];
		let queries = 0;
		const signal = vi.fn((pid: number) => {
			rows = rows.filter((entry) => entry.pid !== pid);
		});
		expect(
			await stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [10],
				stopSessions: () => {},
				snapshot: async () => withRuntime(++queries === 1 && phase === "late" ? [parent] : rows),
				signal,
			}),
		).toEqual({ status: "stopped" });
		expect(signal.mock.calls.map(([pid]) => pid)).toEqual([11, 10]);
		expect(rows).toEqual([foreign, foreignChild]);
	});

	it.each(["windows", "linux", "bsd"] as const)(
		"accepts legitimate children sharing a %s clock tick",
		async (clock) => {
			const birthTime = clock === "linux" ? { clock, bootId: "boot", value: 400n } : { clock, value: 400n };
			const runtime = { ...row(1, 0), birthTime, preciseIdentity: clock !== "bsd" };
			let rows = [row(10, 1), row(11, 10)].map((entry) => ({
				...entry,
				birthTime,
				preciseIdentity: clock !== "bsd",
			}));
			const signal = vi.fn((pid: number) => {
				rows = rows.filter((entry) => entry.pid !== pid);
			});
			expect(
				await stopRuntimeOwnedProcessTrees({
					runtimePid: 1,
					getRootPids: () => [10],
					stopSessions: () => {},
					snapshot: async () => [runtime, ...rows],
					signal,
				}),
			).toEqual({ status: "stopped" });
			expect(signal.mock.calls.map(([pid]) => pid)).toEqual([11, 10]);
		},
	);

	it.each(["runtime row", "runtime identity", "runtime birth time", "root identity", "root birth time"])(
		"fails closed without %s",
		async (missing) => {
			const runtime = row(1, 0);
			const root = row(10, 1);
			if (missing === "runtime identity") runtime.creationIdentity = "";
			if (missing === "runtime birth time") runtime.birthTime = undefined;
			if (missing === "root identity") root.creationIdentity = "";
			if (missing === "root birth time") root.birthTime = undefined;
			const signal = vi.fn();
			expect(
				await stopRuntimeOwnedProcessTrees({
					runtimePid: 1,
					getRootPids: () => [10],
					includeRuntimeChildren: true,
					stopSessions: () => {},
					snapshot: async () => (missing === "runtime row" ? [root] : [runtime, root]),
					signal,
				}),
			).toEqual({ status: "unconfirmed" });
			expect(signal).not.toHaveBeenCalled();
		},
	);

	it("does not claim complete runtime-child coverage when the runtime row is missing", async () => {
		expect(
			await stopRuntimeOwnedProcessTrees({
				runtimePid: 1,
				getRootPids: () => [],
				includeRuntimeChildren: true,
				stopSessions: () => {},
				snapshot: async () => [],
				signal: vi.fn(),
			}),
		).toEqual({ status: "unconfirmed" });
	});

	it.each(["initial", "late"])(
		"retains unknown %s ancestry coverage without adopting or orphaning it",
		async (phase) => {
			for (const child of [
				{ ...row(11, 10), creationIdentity: "" },
				{ ...row(11, 10), birthTime: undefined },
				{ ...row(11, 10), birthTime: { clock: "linux" as const, bootId: "other", value: 11n } },
			]) {
				let rows = [row(10, 1), child, row(12, 11)];
				let queries = 0;
				const signal = vi.fn();
				const onUnconfirmed = vi.fn();
				const shutdown = createRuntimeOwnedProcessShutdown({
					runtimePid: 1,
					getRootPids: () => [10],
					snapshot: async () => withRuntime(++queries === 1 && phase === "late" ? [row(10, 1)] : rows),
					signal,
					timeoutMs: 0,
					onUnconfirmed,
				});
				expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
				expect(signal).not.toHaveBeenCalled();
				expect(onUnconfirmed.mock.calls[0]?.[0]).toMatchObject({ coverageUncertain: true, targetCount: 1 });
				rows = [];
				expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
			}
		},
	);

	it("never mistakes a missing current identity for proof of PID replacement", async () => {
		let queries = 0;
		const signal = vi.fn();
		const onUnconfirmed = vi.fn();
		const shutdown = createRuntimeOwnedProcessShutdown({
			runtimePid: 1,
			getRootPids: () => [10],
			snapshot: async () => withRuntime([row(10, 1, ++queries === 1 ? "captured" : "")]),
			signal,
			timeoutMs: 0,
			onUnconfirmed,
		});
		expect(await shutdown(() => {})).toEqual({ status: "unconfirmed" });
		expect(signal).not.toHaveBeenCalled();
		expect(onUnconfirmed.mock.calls[0]?.[0].blockers[0]).toMatchObject({
			identityPresent: false,
			reason: "identity_unavailable",
		});
	});

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
				snapshot: async () => withRuntime(rows),
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
				snapshot: async () => withRuntime(rows),
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
				return withRuntime([row(51, 99)]);
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
				return withRuntime([row(11, 99)]);
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
			snapshot: async () => withRuntime(rows),
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
				if (++queries === 1) return withRuntime([row(10, 1, "original")]);
				if (failObservation) throw new Error("synthetic snapshot error");
				return withRuntime([row(10, 1, "replacement")]);
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
			snapshot: async () => withRuntime(rows),
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
		const snapshot = vi.fn(async () => withRuntime(rows));
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
				snapshot: async () => withRuntime(++queries === 1 ? [row(10, 1, "old")] : [row(10, 1, "replacement")]),
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
				snapshot: async () => withRuntime([row(10, 99)]),
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
					if (++queries === 1) return withRuntime([row(10, 1)]);
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
					if (++queries === 1) return withRuntime([row(10, 1), row(11, 10)]);
					return withRuntime(descendantLive ? [row(11, 99)] : []);
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
				snapshot: async () => withRuntime([row(10, 1)]),
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
						if (queries === 1) return withRuntime([row(10, 1), { ...row(11, 10), preciseIdentity: false }]);
						if (queries === 2) return withRuntime([{ ...row(11, 99), preciseIdentity: false }]);
						return withRuntime([]);
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
					if (queries === 1) return withRuntime([coarseRow(10, 1), coarseRow(11, 10)]);
					if (queries === 2) return withRuntime([coarseRow(11, 99), coarseRow(12, 11)]);
					return withRuntime([coarseRow(12, 99)]);
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
				snapshot: async () =>
					withRuntime([
						{
							...row(10, ++queries === 1 ? 1 : 99),
							preciseIdentity: false,
						},
					]),
			}),
		).toEqual({ status: "unconfirmed" });
		expect(signal).not.toHaveBeenCalled();
	});
});
