import { describe, expect, it, vi } from "vitest";
import type { DesktopPerformancePorts } from "../../../scripts/agent-lab/desktop-performance";
import {
	DesktopPerformanceScenarioError,
	type DesktopPerformanceScenarioScope,
	type DesktopPerformanceScenarioUi,
	exerciseDesktopPerformanceScenario,
	validateDesktopPerformanceSelection,
} from "../../../scripts/agent-lab/desktop-performance-scenario";
import type { DesktopLabProcess } from "../../../scripts/agent-lab/desktop-types";

describe("desktop-only performance selection", () => {
	it("accepts only its hidden deterministic fake default", () => {
		expect(() => validateDesktopPerformanceSelection({})).not.toThrow();
	});
	it.each([
		{ notifications: true },
		{ compareWindow: true },
		{ mainLoss: true },
		{ nativeExperience: true },
		{ manualShells: true },
		{ npmLaunch: true },
		{ sessionRecovery: true },
		{ showWindow: true },
		{ includeAgent: false },
		{ agentMode: "real-codex" as const },
		{ agentMode: "real-claude" as const },
	])("rejects conflicting selections: %j", (options) => {
		expect(() => validateDesktopPerformanceSelection(options)).toThrow("hidden fake-provider lane");
	});
});

const birth = "Thu Oct  1 12:00:00 2026";
function row(pid: number, parentPid: number, command: string, startedAt = birth): DesktopLabProcess {
	return { pid, parentPid, command, startedAt };
}
function fixture() {
	let now = 0;
	const admitted = [
		row(10, 1, "main private-argument"),
		row(11, 10, "renderer --type=renderer"),
		row(12, 10, "helper"),
		row(13, 12, "fake-agent"),
		row(18, 10, "old-renderer", "old-birth"),
	];
	const census = [...admitted.slice(0, 4), row(18, 1, "unrelated reused PID"), row(30, 1, "unrelated chromium")];
	const scope: DesktopPerformanceScenarioScope = {
		runId: "performance-test",
		projectId: "project",
		taskId: "task",
		desktopMainPid: 10,
		runtimeHelperPid: 12,
		readAdmittedDesktop: () => admitted,
		conditions: { desktopVisible: false },
	};
	const advance = (milliseconds: number) => {
		now += milliseconds;
	};
	const measurement: DesktopPerformancePorts = {
		now: () => now,
		wait: async (milliseconds) => advance(milliseconds),
		readPs: vi.fn(async (pids: readonly number[]) =>
			pids
				.flatMap((pid) => {
					const process = census.find((candidate) => candidate.pid === pid);
					const cpu = `${Math.floor(now / 60_000)}:${((now / 1_000) % 60).toFixed(2).padStart(5, "0")}`;
					return process ? [`${pid} S ${process.startedAt} ${cpu} ${pid * 100}\n`] : [];
				})
				.join(""),
		),
	};
	const progress = vi.fn(async (_client: "desktop", marker: string) => {
		advance(20);
		return { terminalResponse: `AGENT LAB PROGRESS: ${marker}`, historyMarker: marker };
	});
	const ui: DesktopPerformanceScenarioUi = {
		navigate: vi.fn(async () => {
			advance(10);
			return {
				boundary: "ui-action-to-terminal-visible" as const,
				clock: "renderer-monotonic" as const,
				durationMs: 4,
				viewport: { width: 1460, height: 1012 },
			};
		}),
		progress: { mode: "required", acknowledge: progress },
		verifyScope: vi.fn(async () => {}),
	};
	return { scope, ui, measurement, listProcesses: vi.fn(async () => census), census, admitted, advance, progress };
}

describe("desktop-only performance scenario", () => {
	it("retains idle CPU/RSS, navigation and terminal ACKs for only admitted desktop identities", async () => {
		const f = fixture();
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence).toMatchObject({ completed: true, idleNavigationCompleted: true, stableComparison: true });
		expect(evidence.idleBefore?.samples).toHaveLength(31);
		expect(evidence.idleAfter?.actualDurationMs).toBe(30_000);
		expect(f.ui.navigate).toHaveBeenCalledTimes(5);
		expect(f.progress).toHaveBeenCalledTimes(1);
		expect(evidence.navigation.desktop?.uiDurations).toHaveLength(5);
		expect(evidence.navigation.desktop?.durations.every(({ durationMs }) => durationMs === 10)).toBe(true);
		expect(evidence.progress[0]).toMatchObject({
			durationMs: 20,
			terminalResponseAcknowledged: true,
			historyAcknowledged: true,
		});
		expect(evidence.cohorts[0]?.identities.map(({ pid }) => pid)).toEqual([10, 11, 12, 13]);
		expect(JSON.stringify(evidence)).not.toMatch(/private-argument|unrelated|chromium/);
	});
	it("reports explicit terminal unavailability without submitting input or claiming input latency", async () => {
		const f = fixture();
		f.ui.progress = { mode: "unavailable", reason: "production-terminal-content-disabled" };
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence).toMatchObject({ completed: false, idleNavigationCompleted: true, progress: [] });
		expect(f.progress).not.toHaveBeenCalled();
	});
	it("keeps navigation failure distinct from terminal unavailability", async () => {
		const f = fixture();
		f.ui.progress = { mode: "unavailable", reason: "production-terminal-content-disabled" };
		f.ui.navigate = async () => {
			f.advance(7);
			throw new Error("private navigation failure");
		};
		const error = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(DesktopPerformanceScenarioError);
		if (!(error instanceof DesktopPerformanceScenarioError)) return;
		expect(error.stage).toBe("desktop-navigation");
		expect(error.evidence.navigation.desktop).toMatchObject({ completed: false, completedCycles: 0 });
		expect(error.evidence.navigation.desktop?.durations[0]).toMatchObject({ durationMs: 7, outcome: "failed" });
		expect(error.message).not.toContain("private");
	});
	it.each(["echo", "history", "failure"])("fails honestly for progress %s with partial evidence", async (mismatch) => {
		const f = fixture();
		f.ui.progress = {
			mode: "required",
			acknowledge: async (_client, marker) => {
				f.advance(12);
				if (mismatch === "failure") throw new Error("private terminal failure");
				return {
					terminalResponse: mismatch === "echo" ? marker : `AGENT LAB PROGRESS: ${marker}`,
					historyMarker: mismatch === "history" ? "wrong" : marker,
				};
			},
		};
		const error = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f).catch((error: unknown) => error);
		if (!(error instanceof DesktopPerformanceScenarioError)) throw new Error("Missing partial evidence.");
		expect(error.stage).toBe("desktop-progress");
		expect(error.evidence.progress[0]).toMatchObject({ durationMs: 12, outcome: "failed" });
		expect(error.evidence.idleBefore?.samples).toHaveLength(31);
		expect(JSON.stringify(error)).not.toContain("private terminal");
	});
	it("awaits refreshed admission before each census outside UI duration", async () => {
		const f = fixture();
		let refreshed = false;
		f.scope.readAdmittedDesktop = async () => {
			await Promise.resolve();
			refreshed = true;
			f.advance(3);
			return f.admitted;
		};
		f.listProcesses = vi.fn(async () => {
			expect(refreshed).toBe(true);
			refreshed = false;
			return f.census;
		});
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence.navigation.desktop?.durations.every(({ durationMs }) => durationMs === 10)).toBe(true);
	});
	it("invalidates the stable cohort when a newly admitted desktop child appears", async () => {
		const f = fixture();
		let count = 0;
		f.listProcesses = vi.fn(async () => {
			if (++count === 2) {
				const child = row(23, 10, "desktop utility");
				f.census.push(child);
				f.admitted.push(child);
			}
			return f.census;
		});
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence.stableComparison).toBe(false);
		expect(evidence.idleBefore).toMatchObject({ cohortStable: false });
	});
	it("does not turn a missing process sample into a stable zero", async () => {
		const f = fixture();
		const read = f.measurement.readPs;
		let count = 0;
		f.measurement.readPs = async (pids) => read(++count === 2 ? pids.filter((pid) => pid !== 11) : pids);
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence.stableComparison).toBe(false);
		expect(evidence.idleBefore?.summary.find(({ pid }) => pid === 11)).toMatchObject({
			missingSamples: 1,
			cpuDeltaMs: null,
		});
	});
	it("refuses missing exact helper identity before sampling", async () => {
		const f = fixture();
		f.listProcesses = vi.fn(async () => f.census.filter(({ pid }) => pid !== 12));
		await expect(exerciseDesktopPerformanceScenario(f.scope, f.ui, f)).rejects.toMatchObject({
			stage: "idle-before",
		});
		expect(f.measurement.readPs).not.toHaveBeenCalled();
	});
	it("retains completed raw idle evidence if its ending census fails", async () => {
		const f = fixture();
		let count = 0;
		f.listProcesses = vi.fn(async () => {
			if (++count === 2) throw new Error("private census");
			return f.census;
		});
		const error = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f).catch((error: unknown) => error);
		if (!(error instanceof DesktopPerformanceScenarioError)) throw new Error("Missing partial evidence.");
		expect(error.evidence.idleBefore?.samples).toHaveLength(31);
		expect(error.evidence.idleBefore?.cohortStable).toBe(false);
	});
});
