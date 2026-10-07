import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	captureDesktopPerformanceSnapshot,
	type DesktopPerformancePorts,
	measureDesktopPerformanceCycles,
	measureDesktopPerformanceOperation,
	type PerformanceAcknowledgementBoundary,
	type PerformanceProcessIdentity,
	parsePerformanceCpuTime,
	parsePerformanceNavigationTiming,
	parsePerformanceProcesses,
	sampleDesktopPerformancePhase,
	summarizeDesktopPerformanceSamples,
} from "../../../scripts/agent-lab/desktop-performance";

const identity: PerformanceProcessIdentity = {
	client: "desktop",
	pid: 101,
	startedAt: "Thu Oct  1 12:00:00 2026",
	role: "renderer",
};
function row(cpu = "0:01.25", birth = identity.startedAt, pid = identity.pid, rss = 1_000): string {
	return `${pid} S ${birth} ${cpu} ${rss}\n`;
}
function fixture() {
	let now = 0;
	const dependencies: DesktopPerformancePorts = {
		now: () => now,
		wait: async (milliseconds) => {
			now += milliseconds;
		},
		readPs: vi.fn(async () => row(`0:${String(Math.floor(now / 1_000)).padStart(2, "0")}.00`)),
	};
	return {
		dependencies,
		advance: (milliseconds: number) => {
			now += milliseconds;
		},
	};
}

describe("isolated desktop/browser performance evidence", () => {
	it("admits bounded shared navigation timing and retains only nonsecret measurement fields", () => {
		const timing = {
			boundary: "ui-action-to-terminal-visible",
			clock: "renderer-monotonic",
			durationMs: 30,
			viewport: { width: 1460, height: 1012 },
		};
		expect(
			parsePerformanceNavigationTiming({
				...timing,
				privateOutput: "private command output",
				viewport: { ...timing.viewport, privateOutput: "private dimensions" },
			}),
		).toEqual(timing);
		for (const raw of [
			undefined,
			null,
			{ ...timing, boundary: "wrapper-round-trip" },
			{ ...timing, clock: "wall-clock" },
			{ ...timing, durationMs: Infinity },
			{ ...timing, durationMs: -1 },
			{ ...timing, durationMs: 25001 },
			{ ...timing, viewport: { width: 1.5, height: 1012 } },
			{ ...timing, viewport: { width: 8193, height: 1012 } },
		])
			expect(() => parsePerformanceNavigationTiming(raw)).toThrow(/navigation timing/);
	});
	it.each([
		["0:01.25", 1_250],
		["01:02:03", 3_723_000],
		["1-01:02:03.456", 90_123_456],
		["61:00", 3_660_000],
		["0:60", null],
		["1:60:00", null],
		["nonsense", null],
	])("parses cumulative CPU display %s", (value, expected) => {
		expect(parsePerformanceCpuTime(String(value))).toBe(expected);
	});
	it("accepts only targeted PID/birth observations and never retains unrelated rows", () => {
		expect(parsePerformanceProcesses(row() + row("0:03.00", identity.startedAt, 999), [identity])).toEqual([
			{ ...identity, status: "observed", cpuTimeMs: 1_250, rssKiB: 1_000 },
		]);
		expect(parsePerformanceProcesses(row("0:99.00", "Thu Oct  1 12:01:00 2026"), [identity])[0]).toMatchObject({
			status: "identity-changed",
			cpuTimeMs: null,
			rssKiB: null,
		});
		expect(parsePerformanceProcesses("", [identity])[0]?.status).toBe("missing");
		expect(parsePerformanceProcesses(row().replace(" S ", " Z "), [identity])[0]?.status).toBe("missing");
	});
	it("reads exact tracked PIDs and brackets collection without exposing probe errors", async () => {
		const { dependencies, advance } = fixture();
		dependencies.readPs = vi.fn(async (pids) => {
			expect(pids).toEqual([101]);
			advance(20);
			throw new Error("private argv and environment");
		});
		const snapshot = await captureDesktopPerformanceSnapshot([identity], dependencies);
		expect(snapshot).toMatchObject({
			startedMonoMs: 0,
			finishedMonoMs: 20,
			processes: [{ status: "unavailable", cpuTimeMs: null }],
		});
		expect(JSON.stringify(snapshot)).not.toContain("private");
	});
	it("records a thirty-second monotonic phase on one-second targets with raw samples and normalized CPU", async () => {
		const { dependencies } = fixture();
		const result = await sampleDesktopPerformancePhase("desktop-idle", () => [identity], dependencies);
		expect(result.samples).toHaveLength(31);
		expect(result.samples[0]?.intervals[0]).toMatchObject({
			wallIntervalMs: null,
			cpuDeltaMs: null,
			cpuPercentOneCore: null,
		});
		expect(result.samples[1]?.intervals[0]).toMatchObject({
			wallIntervalMs: 1_000,
			cpuDeltaMs: 1_000,
			cpuPercentOneCore: 100,
		});
		expect(result.actualDurationMs).toBe(30_000);
		expect(result.stableComparison).toBe(true);
		expect(result.summary[0]).toMatchObject({
			observedDurationMs: 30_000,
			cpuDeltaMs: 30_000,
			cpuPercentOneCore: 100,
		});
		expect(result.limitations.join(" ")).toContain("not unique memory");
	});
	it("invalidates stable comparison for missing/reused identities and counter reset instead of filling zero", async () => {
		const { dependencies } = fixture();
		let call = 0;
		dependencies.readPs = async () => (++call === 2 ? row("0:03.00", "Thu Oct  1 12:01:00 2026") : row());
		const result = await sampleDesktopPerformancePhase("reused-pid", () => [identity], dependencies);
		expect(result.stableComparison).toBe(false);
		expect(result.summary[0]).toMatchObject({
			missingSamples: 1,
			cpuDeltaMs: null,
			cpuPercentOneCore: null,
			rssDeltaKiB: null,
		});
		const reset = summarizeDesktopPerformanceSamples([
			{
				startedMonoMs: 0,
				finishedMonoMs: 0,
				intervals: [],
				processes: parsePerformanceProcesses(row("0:03.00"), [identity]),
			},
			{
				startedMonoMs: 1_000,
				finishedMonoMs: 1_000,
				intervals: [],
				processes: parsePerformanceProcesses(row("0:02.00"), [identity]),
			},
		]);
		expect(reset[0]).toMatchObject({ stableComparison: false, cpuCounterReset: true, cpuDeltaMs: null });
	});
	it("keeps client trees separate and reports newly tracked process churn as incomplete", () => {
		const browser: PerformanceProcessIdentity = { ...identity, client: "browser", pid: 202 };
		const summary = summarizeDesktopPerformanceSamples([
			{
				startedMonoMs: 0,
				finishedMonoMs: 0,
				intervals: [],
				processes: parsePerformanceProcesses(row(), [identity]),
			},
			{
				startedMonoMs: 1_000,
				finishedMonoMs: 1_000,
				intervals: [],
				processes: parsePerformanceProcesses(row() + row("0:01.00", browser.startedAt, browser.pid), [
					identity,
					browser,
				]),
			},
		]);
		expect(summary.map(({ client }) => client)).toEqual(["desktop", "browser"]);
		expect(summary[1]).toMatchObject({ stableComparison: false, cpuDeltaMs: null, missingSamples: 1 });
	});
	it("measures acknowledged operations on one clock and labels wrapper overhead honestly", async () => {
		expectTypeOf<PerformanceAcknowledgementBoundary>().toEqualTypeOf<"driver-to-ui-ack" | "wrapper-round-trip">();
		const { dependencies, advance } = fixture();
		expect(
			await measureDesktopPerformanceOperation(
				"browser-navigation",
				"driver-to-ui-ack",
				async () => advance(25),
				dependencies.now,
			),
		).toEqual({ label: "browser-navigation", boundary: "driver-to-ui-ack", durationMs: 25, outcome: "acknowledged" });
		expect(
			await measureDesktopPerformanceOperation(
				"wrapper-observation",
				"wrapper-round-trip",
				async () => advance(50),
				dependencies.now,
			),
		).toMatchObject({ boundary: "wrapper-round-trip", durationMs: 50 });
	});
	it("preserves before/after and raw repeated-cycle evidence while stopping on a failed acknowledgement", async () => {
		const { dependencies, advance } = fixture();
		const cycle = vi.fn(async (index: number) => {
			advance(1_000);
			if (index === 1) throw new Error("secret operation failure");
		});
		const result = await measureDesktopPerformanceCycles(
			{ label: "task-cycle", count: 3, boundary: "driver-to-ui-ack", tracked: () => [identity], cycle },
			dependencies,
		);
		expect(result).toMatchObject({
			completed: false,
			stableComparison: false,
			completedCycles: 1,
			requestedCycles: 3,
		});
		expect(result.samples).toHaveLength(3);
		expect(result.before).toBe(result.samples[0]);
		expect(result.after).toBe(result.samples[2]);
		expect(result.durations.map(({ outcome }) => outcome)).toEqual(["acknowledged", "failed"]);
		expect(cycle).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(result)).not.toContain("secret");
	});
	it("projects only nonsecret identity fields even when caller objects contain process arguments", async () => {
		const callerIdentity = { ...identity, command: "private command", environment: "private environment" };
		const { dependencies } = fixture();
		const observed = await captureDesktopPerformanceSnapshot([callerIdentity], dependencies);
		expect(JSON.stringify(observed)).not.toContain("private");
		dependencies.readPs = async () => {
			throw new Error("private ps exception");
		};
		expect(JSON.stringify(await captureDesktopPerformanceSnapshot([callerIdentity], dependencies))).not.toContain(
			"private",
		);
	});
	it("uses collection midpoints for each CPU interval and does not normalize resets or missing observations", async () => {
		const { dependencies, advance } = fixture();
		let call = 0;
		dependencies.readPs = async () => {
			advance(20);
			return ++call === 1 ? row("0:01.00") : call === 2 ? row("0:02.00") : call === 3 ? row("0:01.00") : "";
		};
		const first = await captureDesktopPerformanceSnapshot([identity], dependencies);
		advance(980);
		const second = await captureDesktopPerformanceSnapshot([identity], dependencies, first);
		expect(second.intervals[0]).toMatchObject({ wallIntervalMs: 1_000, cpuDeltaMs: 1_000, cpuPercentOneCore: 100 });
		advance(980);
		const reset = await captureDesktopPerformanceSnapshot([identity], dependencies, second);
		expect(reset.intervals[0]).toMatchObject({ cpuCounterReset: true, cpuDeltaMs: null, cpuPercentOneCore: null });
		advance(980);
		const missing = await captureDesktopPerformanceSnapshot([identity], dependencies, reset);
		expect(missing.intervals[0]).toMatchObject({ wallIntervalMs: 1_000, cpuDeltaMs: null, cpuPercentOneCore: null });
	});
	it("retains successful cycle timings and before/after per-process memory without summing shared RSS", async () => {
		const { dependencies, advance } = fixture();
		let reads = 0;
		dependencies.readPs = async () => row(`0:0${reads}.00`, identity.startedAt, identity.pid, 1_000 + reads++ * 100);
		const result = await measureDesktopPerformanceCycles(
			{
				label: "window-cycle",
				count: 3,
				boundary: "driver-to-ui-ack",
				tracked: () => [identity],
				cycle: async () => advance(1_000),
			},
			dependencies,
		);
		expect(result).toMatchObject({ completed: true, stableComparison: true, completedCycles: 3 });
		expect(result.durations.map(({ durationMs }) => durationMs)).toEqual([1_000, 1_000, 1_000]);
		expect(result.summary[0]).toMatchObject({
			firstRssKiB: 1_000,
			lastRssKiB: 1_300,
			rssDeltaKiB: 300,
			cpuPercentOneCore: 100,
		});
		expect(result.samples).toHaveLength(4);
	});
	it("refuses duplicate/invalid identities and unbounded cycle counts before probing", async () => {
		const { dependencies } = fixture();
		await expect(captureDesktopPerformanceSnapshot([identity, identity], dependencies)).rejects.toThrow(
			"distinct captured",
		);
		await expect(captureDesktopPerformanceSnapshot([{ ...identity, pid: -1 }], dependencies)).rejects.toThrow(
			"distinct captured",
		);
		await expect(
			measureDesktopPerformanceCycles(
				{
					label: "cycle",
					count: 51,
					boundary: "driver-to-ui-ack",
					tracked: () => [identity],
					cycle: async () => {},
				},
				dependencies,
			),
		).rejects.toThrow("one and fifty");
		expect(dependencies.readPs).not.toHaveBeenCalled();
	});
});
