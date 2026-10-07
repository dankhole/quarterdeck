import { describe, expect, it, vi } from "vitest";
import { _testing as browserProcesses } from "../../../scripts/agent-lab/browser-processes";
import type { DesktopPerformancePorts } from "../../../scripts/agent-lab/desktop-performance";
import {
	DesktopPerformanceScenarioError,
	type DesktopPerformanceScenarioScope,
	type DesktopPerformanceScenarioUi,
	exerciseDesktopPerformanceScenario,
} from "../../../scripts/agent-lab/desktop-performance-scenario";
import type { DesktopLabProcess } from "../../../scripts/agent-lab/desktop-types";

const session = "qd-desktop-browser-performance-test";
const birth = "Thu Oct  1 12:00:00 2026";
const root = process.cwd();
const daemon = browserProcesses.resolvePlaywrightDaemonEntrypoint(root);

function processRow(pid: number, parentPid: number, command: string, startedAt = birth): DesktopLabProcess {
	return { pid, parentPid, command, startedAt };
}
function fixture() {
	let now = 0;
	const desktop = [
		processRow(10, 1, "/isolated/Quarterdeck.app/main --private-argument=not-for-evidence"),
		processRow(11, 10, "/isolated/Quarterdeck.app/renderer --type=renderer"),
		processRow(12, 10, "/isolated/Quarterdeck.app/runtime-helper"),
		processRow(13, 12, "/isolated/fake-codex"),
		processRow(18, 10, "/isolated/old-renderer", "Thu Oct  1 11:59:00 2026"),
	];
	const census = [
		...desktop.slice(0, 4),
		processRow(18, 1, "/unrelated/reused-pid"),
		processRow(20, 1, `/usr/bin/node ${daemon} ${session}`),
		processRow(21, 20, "/isolated/chromium --headless"),
		processRow(22, 21, "/isolated/chromium --type=renderer"),
		processRow(30, 1, "/unrelated/chromium --type=renderer"),
		processRow(40, 1, `/usr/bin/node ${daemon} qd-unrelated-browser`),
		processRow(41, 40, "/unrelated/chromium"),
	];
	const scope: DesktopPerformanceScenarioScope = {
		runId: "performance-test",
		repoRoot: root,
		browserSession: session,
		projectId: "project",
		taskId: "task",
		desktopMainPid: 10,
		runtimeHelperPid: 12,
		readAdmittedDesktop: () => desktop,
		conditions: { desktopVisible: false, browserHeadless: true },
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
	const listProcesses = vi.fn(async () => census);
	const progress = vi.fn(async (_client: "desktop" | "browser", marker: string) => {
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
	return { scope, ui, measurement, listProcesses, census, advance, progress };
}

describe("measurement-only desktop/browser performance scenario", () => {
	it("measures only idle/navigation when production terminal content is explicitly unavailable, without submitting input", async () => {
		const f = fixture();
		f.ui.progress = { mode: "unavailable", reason: "production-terminal-content-disabled" };
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence).toMatchObject({
			completed: false,
			idleNavigationCompleted: true,
			stableComparison: true,
			progressAvailability: { mode: "unavailable", reason: "production-terminal-content-disabled" },
			progress: [],
		});
		expect(f.progress).not.toHaveBeenCalled();
		expect(f.ui.navigate).toHaveBeenCalledTimes(10);
		expect(evidence.idleBefore?.samples).toHaveLength(31);
		expect(evidence.idleAfter?.samples).toHaveLength(31);
		expect(evidence.navigation.desktop?.completedCycles).toBe(5);
		expect(evidence.navigation.browser?.completedCycles).toBe(5);
		expect(evidence.navigation.desktop?.uiDurations).toHaveLength(5);
		expect(evidence.navigation.browser?.uiDurations).toHaveLength(5);
	});
	it("keeps an unexpected required terminal callback failure distinct from explicit unavailability", async () => {
		const f = fixture();
		f.ui.progress = {
			mode: "required",
			acknowledge: async () => {
				f.advance(7);
				throw new Error("private terminal observer failure");
			},
		};
		const error = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f).catch((error: unknown) => error);
		if (!(error instanceof DesktopPerformanceScenarioError)) throw new Error("Expected required ACK failure.");
		expect(error.stage).toBe("desktop-progress");
		expect(error.evidence).toMatchObject({
			completed: false,
			idleNavigationCompleted: false,
			progressAvailability: { mode: "required" },
		});
		expect(error.evidence.progress[0]).toMatchObject({
			outcome: "failed",
			durationMs: 7,
			terminalResponseAcknowledged: false,
			historyAcknowledged: false,
		});
		expect(JSON.stringify(error)).not.toContain("private terminal");
	});
	it("does not hide a navigation failure behind the explicit terminal-unavailable mode", async () => {
		const f = fixture();
		f.ui.progress = { mode: "unavailable", reason: "production-terminal-content-disabled" };
		f.ui.navigate = async () => {
			throw new Error("private navigation failure");
		};
		const error = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f).catch((error: unknown) => error);
		if (!(error instanceof DesktopPerformanceScenarioError)) throw new Error("Expected navigation failure.");
		expect(error.stage).toBe("desktop-navigation");
		expect(error.evidence.idleNavigationCompleted).toBe(false);
		expect(error.evidence.navigation.desktop?.completed).toBe(false);
		expect(error.evidence.progress).toEqual([]);
		expect(f.progress).not.toHaveBeenCalled();
	});
	it("awaits fresh driver admission before each single census without timing that refresh as UI latency", async () => {
		const f = fixture();
		const readAdmitted = f.scope.readAdmittedDesktop;
		let refreshed = false;
		f.scope.readAdmittedDesktop = async () => {
			await Promise.resolve();
			refreshed = true;
			f.advance(3);
			return readAdmitted();
		};
		f.listProcesses = vi.fn(async () => {
			expect(refreshed).toBe(true);
			refreshed = false;
			return f.census;
		});
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence.completed).toBe(true);
		expect(evidence.navigation.desktop?.durations.every(({ durationMs }) => durationMs === 10)).toBe(true);
		expect(evidence.navigation.desktop?.uiDurations.every(({ durationMs }) => durationMs === 4)).toBe(true);
		expect(evidence.progress.every(({ durationMs }) => durationMs === 20)).toBe(true);
	});
	it("reuses one exact task/browser tree and retains honest timings and paired raw idle evidence", async () => {
		const f = fixture();
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence).toMatchObject({
			completed: true,
			idleNavigationCompleted: true,
			stableComparison: true,
			conditions: { desktopVisible: false, browserHeadless: true },
		});
		expect(evidence.idleBefore?.samples).toHaveLength(31);
		expect(evidence.idleAfter?.samples).toHaveLength(31);
		expect(evidence.idleBefore?.actualDurationMs).toBe(30_000);
		expect(evidence.idleAfter?.actualDurationMs).toBe(30_000);
		expect(f.ui.navigate).toHaveBeenCalledTimes(10);
		expect(f.progress).toHaveBeenCalledTimes(2);
		expect(
			evidence.navigation.desktop?.durations.every(
				({ boundary, durationMs }) => boundary === "driver-to-ui-ack" && durationMs === 10,
			),
		).toBe(true);
		expect(evidence.navigation.browser?.durations.every(({ boundary }) => boundary === "wrapper-round-trip")).toBe(
			true,
		);
		for (const client of ["desktop", "browser"] as const)
			expect(evidence.navigation[client]?.uiDurations).toEqual(
				Array.from({ length: 5 }, (_, index) => ({
					label: `${client}-navigation-${index + 1}`,
					boundary: "ui-action-to-terminal-visible",
					clock: "renderer-monotonic",
					durationMs: 4,
					viewport: { width: 1460, height: 1012 },
				})),
			);
		expect(evidence.progress.map(({ boundary, durationMs }) => [boundary, durationMs])).toEqual([
			["driver-to-ui-ack", 20],
			["wrapper-round-trip", 20],
		]);
		expect(evidence.cohorts[0]?.identities).toEqual([
			{ client: "desktop", pid: 10, startedAt: birth, role: "main" },
			{ client: "desktop", pid: 11, startedAt: birth, role: "renderer" },
			{ client: "shared-runtime", pid: 12, startedAt: birth, role: "helper" },
			{ client: "shared-runtime", pid: 13, startedAt: birth, role: "other-owned" },
			{ client: "browser", pid: 20, startedAt: birth, role: "other-owned" },
			{ client: "browser", pid: 21, startedAt: birth, role: "browser" },
			{ client: "browser", pid: 22, startedAt: birth, role: "renderer" },
		]);
		expect(JSON.stringify(evidence)).not.toMatch(/private-argument|unrelated|\/isolated\//u);
		expect(evidence.limitations.join(" ")).toContain("not a comparative speed ratio");
	});
	it("keeps inner worker timing distinct from unequal outer driver and wrapper durations", async () => {
		const f = fixture();
		f.ui.navigate = async (client) => {
			f.advance(client === "desktop" ? 15 : 1500);
			return {
				boundary: "ui-action-to-terminal-visible",
				clock: "renderer-monotonic",
				durationMs: 4,
				viewport: { width: 1460, height: 1012 },
			};
		};
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence.schemaVersion).toBe(2);
		expect(evidence.navigation.desktop?.durations.map(({ durationMs }) => durationMs)).toEqual([15, 15, 15, 15, 15]);
		expect(evidence.navigation.browser?.durations.map(({ durationMs }) => durationMs)).toEqual([
			1500, 1500, 1500, 1500, 1500,
		]);
		for (const client of ["desktop", "browser"] as const)
			expect(evidence.navigation[client]?.uiDurations.map(({ durationMs }) => durationMs)).toEqual([4, 4, 4, 4, 4]);
	});
	it("does not claim stable comparison when the clients use different renderer viewports", async () => {
		const f = fixture();
		const navigate = f.ui.navigate;
		f.ui.navigate = async (client) => ({
			...(await navigate(client)),
			viewport: { width: 1460, height: client === "desktop" ? 1012 : 1040 },
		});
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence.completed).toBe(true);
		expect(evidence.stableComparison).toBe(false);
	});
	it("refuses missing or malformed inner timing without silently using wrapper duration", async () => {
		const f = fixture();
		f.ui.navigate = async () => ({
			boundary: "ui-action-to-terminal-visible",
			clock: "renderer-monotonic",
			durationMs: NaN,
			viewport: { width: 1460, height: 1012 },
		});
		const error = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f).catch((error: unknown) => error);
		if (!(error instanceof DesktopPerformanceScenarioError)) throw new Error("Expected timing rejection.");
		expect(error.stage).toBe("desktop-navigation");
		expect(error.evidence.navigation.desktop?.uiDurations).toEqual([]);
		expect(error.evidence.navigation.desktop?.completed).toBe(false);
	});
	it("invalidates an idle phase and whole comparison when a newly admitted browser child changes the cohort", async () => {
		const f = fixture();
		let count = 0;
		f.listProcesses = vi.fn(async () => {
			if (++count === 2) f.census.push(processRow(23, 21, "/isolated/chromium --type=utility"));
			return f.census;
		});
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence.completed).toBe(true);
		expect(evidence.stableComparison).toBe(false);
		expect(evidence.idleBefore).toMatchObject({ cohortStable: false, stableComparison: false });
		expect(evidence.cohorts[1]?.matchesInitial).toBe(false);
		expect(evidence.idleAfter?.samples[0]?.processes.some(({ pid }) => pid === 23)).toBe(true);
	});
	it("does not turn a missing observed process into a stable or zero-filled idle result", async () => {
		const f = fixture();
		const read = f.measurement.readPs;
		let count = 0;
		f.measurement.readPs = async (pids) => read(++count === 2 ? pids.filter((pid) => pid !== 22) : pids);
		const evidence = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f);
		expect(evidence.stableComparison).toBe(false);
		expect(evidence.idleBefore?.summary.find(({ pid }) => pid === 22)).toMatchObject({
			missingSamples: 1,
			cpuDeltaMs: null,
			cpuPercentOneCore: null,
		});
	});
	it.each(["echo", "history"])("rejects a progress %s mismatch with retained failed duration", async (mismatch) => {
		const f = fixture();
		f.ui.progress = {
			mode: "required",
			acknowledge: async (_client, marker) => {
				f.advance(12);
				return {
					terminalResponse: mismatch === "echo" ? marker : `AGENT LAB PROGRESS: ${marker}`,
					historyMarker: mismatch === "history" ? "wrong-marker" : marker,
				};
			},
		};
		const error = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(DesktopPerformanceScenarioError);
		if (!(error instanceof DesktopPerformanceScenarioError)) throw new Error("Expected partial measurement error.");
		expect(error.stage).toBe("desktop-progress");
		expect(error.evidence.idleBefore?.samples).toHaveLength(31);
		expect(error.evidence.progress[0]).toMatchObject({
			outcome: "failed",
			durationMs: 12,
			terminalResponseAcknowledged: mismatch !== "echo",
			historyAcknowledged: mismatch !== "history",
		});
		expect(error.evidence.completed).toBe(false);
	});
	it("stops on a failed browser UI acknowledgement, retaining raw failed cycle and withholding errors", async () => {
		const f = fixture();
		f.ui.navigate = async (client) => {
			f.advance(5);
			if (client === "browser") throw new Error("private browser command output");
			return {
				boundary: "ui-action-to-terminal-visible",
				clock: "renderer-monotonic",
				durationMs: 4,
				viewport: { width: 1460, height: 1012 },
			};
		};
		const error = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f).catch((error: unknown) => error);
		if (!(error instanceof DesktopPerformanceScenarioError)) throw new Error("Expected measurement error.");
		expect(error.stage).toBe("browser-navigation");
		expect(error.evidence.navigation.browser).toMatchObject({ completed: false, completedCycles: 0 });
		expect(error.evidence.navigation.browser?.durations[0]).toMatchObject({ outcome: "failed", durationMs: 5 });
		expect(JSON.stringify(error)).not.toContain("private browser");
	});
	it("fails closed for missing desktop identity or ambiguous named daemon without executable-name discovery", async () => {
		for (const missingDesktop of [true, false]) {
			const f = fixture();
			f.listProcesses = vi.fn(async () =>
				missingDesktop
					? f.census.filter(({ pid }) => pid !== 12)
					: [...f.census, processRow(50, 1, `/usr/bin/node ${daemon} ${session}`)],
			);
			const error = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f).catch((error: unknown) => error);
			if (!(error instanceof DesktopPerformanceScenarioError)) throw new Error("Expected admission failure.");
			expect(error.stage).toBe("idle-before");
			expect(error.evidence.cohorts).toHaveLength(0);
			expect(f.measurement.readPs).not.toHaveBeenCalled();
			expect(f.ui.navigate).not.toHaveBeenCalled();
		}
	});
	it("retains a completed raw idle phase when its ending identity census fails", async () => {
		const f = fixture();
		let count = 0;
		f.listProcesses = vi.fn(async () => {
			if (++count === 2) throw new Error("private census output");
			return f.census;
		});
		const error = await exerciseDesktopPerformanceScenario(f.scope, f.ui, f).catch((error: unknown) => error);
		if (!(error instanceof DesktopPerformanceScenarioError)) throw new Error("Expected partial census failure.");
		expect(error.evidence.idleBefore).toMatchObject({ stableComparison: false, cohortStable: false });
		expect(error.evidence.idleBefore?.samples).toHaveLength(31);
		expect(error.message).not.toContain("private");
	});
});
