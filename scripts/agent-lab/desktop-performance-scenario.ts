import { findAgentLabBrowserProcessTree } from "./browser-processes";
import {
	DesktopPerformanceOperationError,
	type DesktopPerformancePorts,
	measureDesktopPerformanceCycles,
	measureDesktopPerformanceOperation,
	type PerformanceNavigationTiming,
	type PerformanceProcessIdentity,
	parsePerformanceNavigationTiming,
	sampleDesktopPerformancePhase,
} from "./desktop-performance";
import { collectOwnedDesktopProcesses, listDesktopProcesses, sameDesktopProcess } from "./desktop-processes";
import type { DesktopLabProcess } from "./desktop-types";

type Client = "desktop" | "browser";
const CYCLES = 5;

/** Select the one hidden fake measurement lane before preparing state or accessing a provider. */
export function validateDesktopPerformanceSelection(options: {
	includeAgent?: boolean;
	showWindow?: boolean;
	agentMode?: string;
	npmLaunch?: boolean;
	manualShells?: boolean;
	nativeExperience?: boolean;
	mainLoss?: boolean;
}): void {
	if (
		options.includeAgent === false ||
		options.showWindow ||
		(options.agentMode ?? "fake") !== "fake" ||
		options.npmLaunch ||
		options.manualShells ||
		options.nativeExperience ||
		options.mainLoss
	)
		throw new Error("Desktop performance measurements require the hidden fake-provider lane and no other scenario.");
}

export interface DesktopPerformanceScenarioScope {
	runId: string;
	repoRoot: string;
	browserSession: string;
	projectId: string;
	taskId: string;
	desktopMainPid: number;
	runtimeHelperPid: number;
	/** Bounded refresh of driver admission; retained historical identities are filtered against the next census. */
	readAdmittedDesktop: () => readonly DesktopLabProcess[] | Promise<readonly DesktopLabProcess[]>;
	conditions: { desktopVisible: boolean; browserHeadless: boolean };
}

export type DesktopPerformanceScenarioProgress =
	| {
			mode: "required";
			/**
			 * Bounded callback: submit /progress through the current task's actual terminal input, then observe
			 * the exact prefixed response line in that client's terminal output and verify the matching disk history.
			 * Input echo, an HTTP success, or disk history alone is insufficient. Failure never becomes unavailability.
			 */
			acknowledge: (client: Client, marker: string) => Promise<{ terminalResponse: string; historyMarker: string }>;
	  }
	| { mode: "unavailable"; reason: "production-terminal-content-disabled" };

export interface DesktopPerformanceScenarioUi {
	/** Bounded callback: board -> same existing task, ending with the selected task's Terminal input visible. */
	navigate: (client: Client) => Promise<PerformanceNavigationTiming>;
	/** An explicit unavailable mode submits no input and makes no terminal-input latency claim. */
	progress: DesktopPerformanceScenarioProgress;
	/** Bounded callback: assert the existing runtime owner/generation, selected project/task and native session identity. */
	verifyScope: () => Promise<void>;
}

export interface DesktopPerformanceScenarioDependencies {
	listProcesses?: () => Promise<DesktopLabProcess[]>;
	measurement?: DesktopPerformancePorts;
}

type IdleEvidence = Awaited<ReturnType<typeof sampleDesktopPerformancePhase>> & { cohortStable: boolean };
type CycleEvidence = Awaited<ReturnType<typeof measureDesktopPerformanceCycles>> & {
	uiDurations: Array<PerformanceNavigationTiming & { label: string }>;
};
type ProgressEvidence = Awaited<ReturnType<typeof measureDesktopPerformanceOperation>> & {
	client: Client;
	terminalResponseAcknowledged: boolean;
	historyAcknowledged: boolean;
};
export interface DesktopPerformanceScenarioEvidence {
	schemaVersion: 2;
	runId: string;
	projectId: string;
	taskId: string;
	conditions: DesktopPerformanceScenarioScope["conditions"];
	completed: boolean;
	idleNavigationCompleted: boolean;
	stableComparison: boolean;
	progressAvailability: { mode: "required" } | { mode: "unavailable"; reason: "production-terminal-content-disabled" };
	cohorts: Array<{ checkpoint: string; identities: PerformanceProcessIdentity[]; matchesInitial: boolean }>;
	idleBefore?: IdleEvidence;
	idleAfter?: IdleEvidence;
	navigation: Partial<Record<Client, CycleEvidence>>;
	progress: ProgressEvidence[];
	limitations: readonly string[];
}

export class DesktopPerformanceScenarioError extends Error {
	constructor(
		readonly stage: string,
		readonly evidence: DesktopPerformanceScenarioEvidence,
	) {
		super(`Desktop performance scenario failed at ${stage}; preserve partial measurements and use owner cleanup.`);
		this.name = "DesktopPerformanceScenarioError";
	}
}

const LIMITATIONS = [
	"Navigation uses the same existing task and window; these cycles do not measure task launch, new-window startup, or provider lifecycle.",
	"Outer desktop durations include driver-to-UI acknowledgement and outer browser durations include the named wrapper round-trip. Only uiDurations share the action-to-terminal-visible boundary; outer durations are not a comparative speed ratio.",
	"Comparable navigation uses the same existing fixture, task and renderer viewport. Both workers execute the same flow and read that renderer's monotonic clock; automation/clock-read overhead remains, and this is not key-to-paint latency.",
	"Progress timings include terminal response observation and disk history integrity verification; they are not pure key-to-paint latency.",
	"Unavailable production terminal content produces no input command or input duration. Idle/navigation completion does not complete the full scenario or establish input latency.",
	"Both clients remain open during paired idle phases. The shared runtime/helper tree is recorded once; this is not an independent browser-only or desktop-only baseline.",
	"Cohorts are admitted before/after phases and navigation groups. Ephemeral processes between censuses and transient wrapper command CPU are not measured.",
	"Process arguments are used only in memory for existing ownership discovery and role classification, never retained in this evidence.",
] as const;

function cohortKey(identities: readonly PerformanceProcessIdentity[]): string {
	return JSON.stringify(identities.map(({ client, pid, startedAt, role }) => [client, pid, startedAt, role]).sort());
}

/** One census establishes both named browser membership and birth identity, avoiding a PID-only second-scan join. */
async function captureCohort(
	scope: DesktopPerformanceScenarioScope,
	list: () => Promise<DesktopLabProcess[]>,
): Promise<PerformanceProcessIdentity[]> {
	const admitted = await scope.readAdmittedDesktop();
	const census = await list();
	const desktop = census.filter((current) => admitted.some((known) => sameDesktopProcess(current, known)));
	if (![scope.desktopMainPid, scope.runtimeHelperPid].every((pid) => desktop.some((process) => process.pid === pid)))
		throw new Error("Current admitted desktop main/helper identity is unavailable.");
	const tree = await findAgentLabBrowserProcessTree(scope.repoRoot, scope.browserSession, {
		runProcessList: async () => ({
			ok: true,
			stdout: census.map(({ pid, parentPid, command }) => `${pid} ${parentPid} ${command}`).join("\n"),
		}),
	});
	if (tree.rootPids.length !== 1 || tree.processPids.length < 2)
		throw new Error("Expected one live named browser daemon and its browser descendants.");
	const browser = census.filter(({ pid }) => tree.processPids.includes(pid));
	if (browser.some(({ pid }) => desktop.some((process) => process.pid === pid)))
		throw new Error("Browser and desktop admitted process trees overlap.");
	const runtimePids = new Set(collectOwnedDesktopProcesses(desktop, [scope.runtimeHelperPid]).map(({ pid }) => pid));
	return [
		...desktop.map(
			({ pid, startedAt, command }): PerformanceProcessIdentity => ({
				pid,
				startedAt,
				client: runtimePids.has(pid) ? "shared-runtime" : "desktop",
				role:
					pid === scope.runtimeHelperPid
						? "helper"
						: pid === scope.desktopMainPid
							? "main"
							: command.includes("--type=renderer")
								? "renderer"
								: "other-owned",
			}),
		),
		...browser.map(
			({ pid, startedAt, command }): PerformanceProcessIdentity => ({
				pid,
				startedAt,
				client: "browser",
				role: tree.rootPids.includes(pid)
					? "other-owned"
					: command.includes("--type=renderer")
						? "renderer"
						: command.includes("--type=")
							? "other-owned"
							: "browser",
			}),
		),
	];
}

/**
 * Measurement only. The existing coexistence owner supplies bounded UI callbacks, admission and final cleanup.
 * Call while its one named browser is open, after the separate full fake baseline has passed.
 * This measurement lane must not repeat renderer/process loss, reload, or runtime-restart acceptance.
 * On failure, write error.evidence before letting that owner's finally close the browser and stop the fixture.
 */
export async function exerciseDesktopPerformanceScenario(
	scope: DesktopPerformanceScenarioScope,
	ui: DesktopPerformanceScenarioUi,
	dependencies: DesktopPerformanceScenarioDependencies = {},
): Promise<DesktopPerformanceScenarioEvidence> {
	if (!/^[a-z0-9][a-z0-9-]{0,120}$/iu.test(scope.runId))
		throw new Error("Invalid synthetic performance run identity.");
	const progressPort = ui.progress;
	if (progressPort.mode === "unavailable" && progressPort.reason !== "production-terminal-content-disabled")
		throw new Error("Invalid explicit terminal measurement unavailability.");
	const evidence: DesktopPerformanceScenarioEvidence = {
		schemaVersion: 2,
		runId: scope.runId,
		projectId: scope.projectId,
		taskId: scope.taskId,
		conditions: {
			desktopVisible: scope.conditions.desktopVisible,
			browserHeadless: scope.conditions.browserHeadless,
		},
		completed: false,
		idleNavigationCompleted: false,
		stableComparison: false,
		progressAvailability:
			progressPort.mode === "required"
				? { mode: "required" }
				: { mode: "unavailable", reason: "production-terminal-content-disabled" },
		cohorts: [],
		navigation: {},
		progress: [],
		limitations: LIMITATIONS,
	};
	let stage = "scope";
	let tracked: PerformanceProcessIdentity[] = [];
	let initialKey: string | undefined;
	const refresh = async (checkpoint: string) => {
		tracked = await captureCohort(scope, dependencies.listProcesses ?? listDesktopProcesses);
		const key = cohortKey(tracked);
		initialKey ??= key;
		evidence.cohorts.push({ checkpoint, identities: tracked, matchesInitial: key === initialKey });
	};
	const idle = async (label: "idle-before" | "idle-after"): Promise<IdleEvidence> => {
		await refresh(`${label}-start`);
		const beforeKey = cohortKey(tracked);
		const result = await sampleDesktopPerformancePhase(label, () => tracked, dependencies.measurement);
		const partial = { ...result, cohortStable: false, stableComparison: false };
		if (label === "idle-before") evidence.idleBefore = partial;
		else evidence.idleAfter = partial;
		await refresh(`${label}-end`);
		const cohortStable = beforeKey === cohortKey(tracked);
		return { ...result, cohortStable, stableComparison: result.stableComparison && cohortStable };
	};
	try {
		await ui.verifyScope();
		stage = "idle-before";
		evidence.idleBefore = await idle("idle-before");
		for (const client of ["desktop", "browser"] as const) {
			stage = `${client}-navigation`;
			await refresh(`${client}-navigation-start`);
			const beforeKey = cohortKey(tracked);
			const uiDurations: CycleEvidence["uiDurations"] = [];
			evidence.navigation[client] = {
				...(await measureDesktopPerformanceCycles(
					{
						label: `${client}-navigation`,
						count: CYCLES,
						boundary: client === "desktop" ? "driver-to-ui-ack" : "wrapper-round-trip",
						tracked: () => tracked,
						cycle: async (index) => {
							const timing = parsePerformanceNavigationTiming(await ui.navigate(client));
							uiDurations.push({ ...timing, label: `${client}-navigation-${index + 1}` });
						},
					},
					dependencies.measurement,
				)),
				uiDurations,
			};
			if (!evidence.navigation[client]?.completed) throw new Error("Navigation acknowledgement failed.");
			await ui.verifyScope();
			await refresh(`${client}-navigation-end`);
			evidence.navigation[client].stableComparison &&= beforeKey === cohortKey(tracked);
			if (progressPort.mode === "unavailable") continue;
			stage = `${client}-progress`;
			const marker = `performance-${scope.runId}-${client}`;
			let terminalResponseAcknowledged = false;
			let historyAcknowledged = false;
			let progress: Awaited<ReturnType<typeof measureDesktopPerformanceOperation>>;
			try {
				progress = await measureDesktopPerformanceOperation(
					`${client}-progress`,
					client === "desktop" ? "driver-to-ui-ack" : "wrapper-round-trip",
					async () => {
						const acknowledged = await progressPort.acknowledge(client, marker);
						terminalResponseAcknowledged = acknowledged.terminalResponse === `AGENT LAB PROGRESS: ${marker}`;
						historyAcknowledged = acknowledged.historyMarker === marker;
						if (!terminalResponseAcknowledged || !historyAcknowledged)
							throw new Error("Progress requires the exact terminal response and disk history marker.");
					},
					dependencies.measurement?.now,
				);
			} catch (error) {
				if (error instanceof DesktopPerformanceOperationError)
					evidence.progress.push({ ...error.sample, client, terminalResponseAcknowledged, historyAcknowledged });
				throw error;
			}
			evidence.progress.push({ ...progress, client, terminalResponseAcknowledged, historyAcknowledged });
			await ui.verifyScope();
			await refresh(`${client}-progress`);
		}
		stage = "idle-after";
		evidence.idleAfter = await idle("idle-after");
		stage = "final-scope";
		await ui.verifyScope();
		evidence.idleNavigationCompleted = true;
		evidence.completed = progressPort.mode === "required";
		evidence.stableComparison =
			evidence.idleBefore.stableComparison &&
			evidence.idleAfter.stableComparison &&
			["desktop", "browser"].every((client) => evidence.navigation[client as Client]?.stableComparison) &&
			evidence.cohorts.every(({ matchesInitial }) => matchesInitial) &&
			[
				...(evidence.navigation.desktop?.uiDurations ?? []),
				...(evidence.navigation.browser?.uiDurations ?? []),
			].every(
				({ viewport }) =>
					viewport.width === evidence.navigation.desktop?.uiDurations[0]?.viewport.width &&
					viewport.height === evidence.navigation.desktop?.uiDurations[0]?.viewport.height,
			);
		return evidence;
	} catch {
		throw new DesktopPerformanceScenarioError(stage, evidence);
	}
}
