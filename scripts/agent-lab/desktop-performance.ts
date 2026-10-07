import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PHASE_MS = 30_000;
const INTERVAL_MS = 1_000;

/** Caller must obtain these from the isolated driver's admitted process tree, never executable-name matches. */
export interface PerformanceProcessIdentity {
	client: "desktop" | "browser" | "shared-runtime";
	pid: number;
	startedAt: string;
	role: "main" | "renderer" | "helper" | "browser" | "agent" | "other-owned";
}
export interface PerformanceProcessSample extends PerformanceProcessIdentity {
	status: "observed" | "missing" | "identity-changed" | "unavailable";
	cpuTimeMs: number | null;
	rssKiB: number | null;
}
export interface PerformanceSnapshot {
	startedMonoMs: number;
	finishedMonoMs: number;
	processes: PerformanceProcessSample[];
	intervals: PerformanceProcessInterval[];
}
export interface PerformanceProcessInterval extends PerformanceProcessIdentity {
	wallIntervalMs: number | null;
	cpuDeltaMs: number | null;
	cpuPercentOneCore: number | null;
	cpuCounterReset: boolean;
}
export type PerformanceAcknowledgementBoundary = "driver-to-ui-ack" | "wrapper-round-trip";
export interface PerformanceDurationSample {
	label: string;
	boundary: PerformanceAcknowledgementBoundary;
	durationMs: number;
	outcome: "acknowledged" | "failed";
}
/** Returned by the same navigation function inside each automation worker, excluding wrapper startup. */
export interface PerformanceNavigationTiming {
	boundary: "ui-action-to-terminal-visible";
	clock: "renderer-monotonic";
	durationMs: number;
	viewport: { width: number; height: number };
}
export interface DesktopPerformancePorts {
	now: () => number;
	wait: (milliseconds: number) => Promise<void>;
	readPs: (pids: readonly number[]) => Promise<string>;
}

const ports: DesktopPerformancePorts = {
	now: () => performance.now(),
	wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
	readPs: async (pids) => {
		if (process.platform !== "darwin") throw new Error("Desktop performance process sampling requires macOS.");
		const { stdout } = await execFileAsync("/bin/ps", ["-p", pids.join(","), "-o", "pid=,stat=,lstart=,time=,rss="], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 128 * 1024,
			env: { ...process.env, LC_ALL: "C" },
		});
		return stdout;
	},
};

export const DESKTOP_PERFORMANCE_LIMITATIONS = [
	"CPU is ps-reported cumulative process CPU time; sampling and display precision limit short deltas. Percent uses one logical CPU and may exceed 100%.",
	"RSS is per-process resident memory, not unique memory. Shared pages can appear in multiple processes; no unique-memory total is inferred.",
	"PID and lstart birth time fence each observation. lstart has one-second precision, so same-second PID reuse cannot be excluded by this probe alone.",
	"Only caller-admitted identities are sampled. Exited or newly created untracked processes are not inferred; process churn and missing samples limit comparisons.",
	"Process collection is bracketed by monotonic timestamps, not instantaneous or synchronized with a renderer clock.",
	"Driver-to-UI acknowledgement includes automation overhead. Wrapper round-trip includes wrapper startup and is not browser UI latency. Hidden window runs do not measure visible native focus or paint.",
	"UI-action-to-terminal-visible uses renderer monotonic clock reads inside the same automation flow, from before Back to board click through Terminal input visibility. It includes automation and clock-read overhead, excludes wrapper startup, and is not event-to-paint latency.",
] as const;

/** Project only bounded measurement metadata; wrapper output never supplies free-form evidence. */
export function parsePerformanceNavigationTiming(raw: unknown): PerformanceNavigationTiming {
	if (!raw || typeof raw !== "object") throw new Error("Missing navigation timing.");
	const durationMs: unknown = Reflect.get(raw, "durationMs");
	const viewport: unknown = Reflect.get(raw, "viewport");
	const width: unknown = viewport && typeof viewport === "object" ? Reflect.get(viewport, "width") : null;
	const height: unknown = viewport && typeof viewport === "object" ? Reflect.get(viewport, "height") : null;
	if (
		Reflect.get(raw, "boundary") !== "ui-action-to-terminal-visible" ||
		Reflect.get(raw, "clock") !== "renderer-monotonic" ||
		typeof durationMs !== "number" ||
		!Number.isFinite(durationMs) ||
		durationMs < 0 ||
		durationMs > 25_000 ||
		typeof width !== "number" ||
		!Number.isInteger(width) ||
		width < 1 ||
		width > 8_192 ||
		typeof height !== "number" ||
		!Number.isInteger(height) ||
		height < 1 ||
		height > 8_192
	)
		throw new Error("Invalid bounded navigation timing.");
	return {
		boundary: "ui-action-to-terminal-visible",
		clock: "renderer-monotonic",
		durationMs,
		viewport: { width, height },
	};
}

function validateLabel(label: string): void {
	if (!/^[a-z][a-z0-9-]{0,79}$/u.test(label)) throw new Error("Invalid performance sample label.");
}
function validateIdentities(identities: readonly PerformanceProcessIdentity[]): void {
	if (
		identities.length > 256 ||
		new Set(identities.map(({ pid }) => pid)).size !== identities.length ||
		identities.some(
			({ pid, startedAt, client, role }) =>
				!Number.isSafeInteger(pid) ||
				pid <= 0 ||
				!/^[\w :]{20,24}$/u.test(startedAt) ||
				!["desktop", "browser", "shared-runtime"].includes(client) ||
				!["main", "renderer", "helper", "browser", "agent", "other-owned"].includes(role),
		)
	)
		throw new Error("Performance sampling requires bounded, distinct captured process identities.");
}
function publicIdentity({ client, pid, startedAt, role }: PerformanceProcessIdentity): PerformanceProcessIdentity {
	return { client, pid, startedAt, role };
}
function elapsed(start: number, finish: number): number {
	if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start)
		throw new Error("Invalid monotonic performance clock.");
	return finish - start;
}

/** Supports ps's mm:ss, hh:mm:ss and day-prefixed accumulated CPU displays without rounding away fractions. */
export function parsePerformanceCpuTime(value: string): number | null {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})(?:\.(\d{1,3}))?$/u.exec(value);
	if (!match || Number(match[4]) >= 60 || (match[2] !== undefined && Number(match[3]) >= 60)) return null;
	const result =
		((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 * 60 + Number(match[3]) * 60 + Number(match[4])) *
			1_000 +
		Number((match[5] ?? "").padEnd(3, "0"));
	return Number.isSafeInteger(result) ? result : null;
}

/** No argv/env is read or retained; unexpected rows and changed births never become measurement authority. */
export function parsePerformanceProcesses(
	contents: string,
	identities: readonly PerformanceProcessIdentity[],
): PerformanceProcessSample[] {
	validateIdentities(identities);
	const rows = new Map<number, { birth: string; cpu: number | null; rss: number | null; zombie: boolean }>();
	for (const line of contents.split("\n")) {
		const match = /^\s*(\d+)\s+(\S+)\s+(.{24})\s+(\S+)\s+(\d+)\s*$/u.exec(line);
		if (!match || !identities.some(({ pid }) => pid === Number(match[1]))) continue;
		const rss = Number(match[5]);
		rows.set(Number(match[1]), {
			birth: match[3]?.trim() ?? "",
			cpu: parsePerformanceCpuTime(match[4] ?? ""),
			rss: Number.isSafeInteger(rss) ? rss : null,
			zombie: match[2]?.startsWith("Z") ?? false,
		});
	}
	return identities.map((identity) => {
		const row = rows.get(identity.pid);
		const status =
			!row || row.zombie
				? "missing"
				: row.birth !== identity.startedAt
					? "identity-changed"
					: row.cpu === null || row.rss === null
						? "unavailable"
						: "observed";
		return {
			...publicIdentity(identity),
			status,
			cpuTimeMs: status === "observed" ? (row?.cpu ?? null) : null,
			rssKiB: status === "observed" ? (row?.rss ?? null) : null,
		};
	});
}

export async function captureDesktopPerformanceSnapshot(
	identities: readonly PerformanceProcessIdentity[],
	dependencies: DesktopPerformancePorts = ports,
	previous?: PerformanceSnapshot,
): Promise<PerformanceSnapshot> {
	validateIdentities(identities);
	const startedMonoMs = dependencies.now();
	let processes: PerformanceProcessSample[];
	try {
		processes = identities.length
			? parsePerformanceProcesses(await dependencies.readPs(identities.map(({ pid }) => pid)), identities)
			: [];
	} catch {
		// ps errors can contain output; preserve missing evidence without copying the exception or unrelated content.
		processes = identities.map((identity) => ({
			...publicIdentity(identity),
			status: "unavailable",
			cpuTimeMs: null,
			rssKiB: null,
		}));
	}
	const finishedMonoMs = dependencies.now();
	elapsed(startedMonoMs, finishedMonoMs);
	const wallIntervalMs = previous
		? elapsed((previous.startedMonoMs + previous.finishedMonoMs) / 2, (startedMonoMs + finishedMonoMs) / 2)
		: null;
	const intervals = processes.map((current): PerformanceProcessInterval => {
		const prior = previous?.processes.find(
			(candidate) =>
				candidate.pid === current.pid &&
				candidate.startedAt === current.startedAt &&
				candidate.client === current.client &&
				candidate.role === current.role,
		);
		const comparable =
			current.status === "observed" &&
			prior?.status === "observed" &&
			current.cpuTimeMs !== null &&
			prior.cpuTimeMs !== null;
		const delta = comparable ? (current.cpuTimeMs ?? 0) - (prior?.cpuTimeMs ?? 0) : null;
		const cpuCounterReset = delta !== null && delta < 0;
		const cpuDeltaMs = !cpuCounterReset && wallIntervalMs !== null && wallIntervalMs > 0 ? delta : null;
		return {
			...publicIdentity(current),
			wallIntervalMs,
			cpuDeltaMs,
			cpuCounterReset,
			cpuPercentOneCore: cpuDeltaMs !== null && wallIntervalMs !== null ? (cpuDeltaMs / wallIntervalMs) * 100 : null,
		};
	});
	return { startedMonoMs, finishedMonoMs, processes, intervals };
}

export function summarizeDesktopPerformanceSamples(samples: readonly PerformanceSnapshot[]) {
	const records = new Map<string, Array<{ process: PerformanceProcessSample; time: number }>>();
	for (const sample of samples)
		for (const process of sample.processes) {
			const key = JSON.stringify([process.client, process.pid, process.startedAt, process.role]);
			const recordsForIdentity = records.get(key) ?? [];
			recordsForIdentity.push({ process, time: (sample.startedMonoMs + sample.finishedMonoMs) / 2 });
			records.set(key, recordsForIdentity);
		}
	return [...records.values()].map((recordsForIdentity) => {
		const observed = recordsForIdentity.filter(({ process }) => process.status === "observed");
		const first = observed[0],
			last = observed.at(-1);
		const cpuCounterReset = observed.some(
			(row, index) => index > 0 && (row.process.cpuTimeMs ?? 0) < (observed[index - 1]?.process.cpuTimeMs ?? 0),
		);
		const durationMs = first && last ? elapsed(first.time, last.time) : 0;
		const stableComparison =
			observed.length === samples.length && observed.length >= 2 && durationMs > 0 && !cpuCounterReset;
		const cpuDeltaMs =
			first && last && stableComparison ? (last.process.cpuTimeMs ?? 0) - (first.process.cpuTimeMs ?? 0) : null;
		const rss = observed.map(({ process }) => process.rssKiB ?? 0);
		const identity = recordsForIdentity[0]?.process;
		return {
			client: identity?.client,
			stableComparison,
			pid: identity?.pid,
			startedAt: identity?.startedAt,
			role: identity?.role,
			observedSamples: observed.length,
			missingSamples: samples.length - observed.length,
			observedDurationMs: durationMs,
			cpuCounterReset,
			cpuDeltaMs,
			cpuPercentOneCore: cpuDeltaMs !== null && durationMs > 0 ? (cpuDeltaMs / durationMs) * 100 : null,
			firstRssKiB: first?.process.rssKiB ?? null,
			lastRssKiB: last?.process.rssKiB ?? null,
			rssDeltaKiB:
				first && last && stableComparison ? (last.process.rssKiB ?? 0) - (first.process.rssKiB ?? 0) : null,
			minRssKiB: rss.length ? Math.min(...rss) : null,
			maxRssKiB: rss.length ? Math.max(...rss) : null,
		};
	});
}

export class DesktopPerformanceOperationError extends Error {
	constructor(readonly sample: PerformanceDurationSample) {
		super(`Performance operation ${sample.label} failed; raw operation error withheld.`);
	}
}

/**
 * The caller must resolve only after the actual selected view or input/output acknowledgement is observed.
 * Timing starts in this Node caller, so it includes driver overhead rather than a renderer event-to-ack interval.
 * The caller must bound its operation with a timeout; this leaf does not cancel or time out UI operations.
 */
export async function measureDesktopPerformanceOperation(
	label: string,
	boundary: PerformanceAcknowledgementBoundary,
	operation: () => Promise<void>,
	now: () => number = ports.now,
): Promise<PerformanceDurationSample> {
	validateLabel(label);
	const started = now();
	try {
		await operation();
	} catch {
		throw new DesktopPerformanceOperationError({
			label,
			boundary,
			durationMs: elapsed(started, now()),
			outcome: "failed",
		});
	}
	return { label, boundary, durationMs: elapsed(started, now()), outcome: "acknowledged" };
}

/** Fixed thirty-second phase, sampled on one-second monotonic targets; returns raw samples for the artifact. */
export async function sampleDesktopPerformancePhase(
	label: string,
	tracked: () => readonly PerformanceProcessIdentity[],
	dependencies: DesktopPerformancePorts = ports,
) {
	validateLabel(label);
	const start = dependencies.now();
	const samples: PerformanceSnapshot[] = [];
	for (let index = 0; index <= PHASE_MS / INTERVAL_MS; index++) {
		const remaining = start + index * INTERVAL_MS - dependencies.now();
		if (remaining > 0) await dependencies.wait(remaining);
		samples.push(await captureDesktopPerformanceSnapshot(tracked(), dependencies, samples.at(-1)));
		if (dependencies.now() - start >= PHASE_MS) break;
	}
	const summary = summarizeDesktopPerformanceSamples(samples);
	return {
		label,
		stableComparison: summary.length > 0 && summary.every((record) => record.stableComparison),
		requestedDurationMs: PHASE_MS,
		intervalMs: INTERVAL_MS,
		actualDurationMs: elapsed(start, dependencies.now()),
		samples,
		summary,
		limitations: DESKTOP_PERFORMANCE_LIMITATIONS,
	};
}

/**
 * Reuses caller-owned window/task flows. It creates no UI, task, runtime, process discovery, or cleanup authority.
 * Each cycle callback must enforce its own timeout and resolve only after its UI acknowledgement.
 */
export async function measureDesktopPerformanceCycles(
	options: {
		label: string;
		count: number;
		boundary: PerformanceAcknowledgementBoundary;
		tracked: () => readonly PerformanceProcessIdentity[];
		cycle: (index: number) => Promise<void>;
	},
	dependencies: DesktopPerformancePorts = ports,
) {
	validateLabel(options.label);
	validateLabel(`${options.label}-${options.count}`);
	if (!Number.isInteger(options.count) || options.count < 1 || options.count > 50)
		throw new Error("Performance cycle count must be between one and fifty.");
	const samples = [await captureDesktopPerformanceSnapshot(options.tracked(), dependencies)];
	const durations: PerformanceDurationSample[] = [];
	let completed = false;
	try {
		for (let index = 0; index < options.count; index++) {
			durations.push(
				await measureDesktopPerformanceOperation(
					`${options.label}-${index + 1}`,
					options.boundary,
					() => options.cycle(index),
					dependencies.now,
				),
			);
			samples.push(await captureDesktopPerformanceSnapshot(options.tracked(), dependencies, samples.at(-1)));
		}
		completed = true;
	} catch (error) {
		if (!(error instanceof DesktopPerformanceOperationError)) throw error;
		durations.push(error.sample);
		samples.push(await captureDesktopPerformanceSnapshot(options.tracked(), dependencies, samples.at(-1)));
	}
	const summary = summarizeDesktopPerformanceSamples(samples);
	return {
		label: options.label,
		stableComparison: completed && summary.length > 0 && summary.every((record) => record.stableComparison),
		requestedCycles: options.count,
		completedCycles: durations.filter(({ outcome }) => outcome === "acknowledged").length,
		completed,
		durations,
		before: samples[0],
		after: samples.at(-1),
		samples,
		summary,
		limitations: DESKTOP_PERFORMANCE_LIMITATIONS,
	};
}
