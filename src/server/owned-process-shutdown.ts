import type { RuntimeOwnedProcessShutdownOutcome } from "../core/api/runtime-shutdown.js";
import {
	compareOwnedProcessBirth,
	type OwnedProcessSnapshot,
	queryOwnedProcessSnapshot,
} from "./owned-process-snapshot.js";

export interface StopRuntimeOwnedProcessTreesOptions {
	getRootPids: () => readonly number[];
	/** Fence lifecycle/restart and mark Interrupted; must not signal or dispose processes. */
	stopSessions: () => void;
	hasPendingLaunches?: () => boolean;
	/** Production includes other direct runtime children (structured providers/LSPs). */
	includeRuntimeChildren?: boolean;
	runtimePid?: number;
	graceMs?: number;
	timeoutMs?: number;
	snapshot?: () => Promise<OwnedProcessSnapshot[]>;
	signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	/** One bounded, metadata-only report per settled incomplete attempt. */
	onUnconfirmed?: (report: OwnedProcessShutdownBlockers) => void;
}

export interface OwnedProcessShutdownBlockers {
	reason: "snapshot_failed" | "deadline" | "coverage_gap";
	targetCount: number;
	coverageUncertain: boolean;
	blockerCount: number;
	blockers: Array<{
		pid: number;
		parentPid: number | null;
		observedParentPid: number | null;
		identityPresent: boolean;
		preciseIdentity: boolean;
		reason: "snapshot_failed" | "identity_unavailable" | "ancestry_changed" | "still_live" | "root_unverified";
	}>;
}

function sameIdentity(left: OwnedProcessSnapshot, right: OwnedProcessSnapshot): boolean {
	return left.pid === right.pid && left.creationIdentity === right.creationIdentity;
}

function ancestry(
	parent: OwnedProcessSnapshot | undefined,
	child: OwnedProcessSnapshot,
): "verified" | "foreign" | "unknown" {
	if (!parent) return "unknown";
	if (parent.pid === child.pid || parent.pid !== child.parentPid) return "foreign";
	const order = compareOwnedProcessBirth(parent, child);
	// A stale PPID can name a newer, unrelated process after PID reuse (notably on Windows).
	return order === null ? "unknown" : order > 0 ? "foreign" : "verified";
}

function selectForest(
	rows: readonly OwnedProcessSnapshot[],
	rootPids: ReadonlySet<number>,
): { owned: OwnedProcessSnapshot[]; possible: OwnedProcessSnapshot[] } {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const selected = new Map([...rootPids].map((pid) => [pid, true]));
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const row of rows) {
			if (selected.has(row.pid) || !selected.has(row.parentPid)) continue;
			const edge = ancestry(byPid.get(row.parentPid), row);
			if (edge === "foreign") continue;
			selected.set(row.pid, edge === "verified" && selected.get(row.parentPid) === true);
			expanded = true;
		}
	}
	return {
		owned: rows.filter((row) => selected.get(row.pid) === true),
		// Unknown edges block parent teardown and clean release, but never authorize adoption/signals.
		possible: rows.filter((row) => selected.has(row.pid)),
	};
}

/** One lifetime owner: retries retain the original identities and coverage gaps. */
export function createRuntimeOwnedProcessShutdown(
	options: Omit<StopRuntimeOwnedProcessTreesOptions, "stopSessions">,
): (stopSessions: () => void) => Promise<RuntimeOwnedProcessShutdownOutcome> {
	const snapshot = options.snapshot ?? queryOwnedProcessSnapshot;
	const signal = options.signal ?? ((pid, name) => process.kill(pid, name));
	const runtimePid = options.runtimePid ?? process.pid;
	let originalRoots: Set<number> | undefined;
	let uncertain = false;
	let targets: OwnedProcessSnapshot[] | undefined;
	let inFlight: Promise<RuntimeOwnedProcessShutdownOutcome> | undefined;
	let stopped = false;
	let observed = new Map<number, OwnedProcessSnapshot>();
	const unverifiedRoots = new Set<number>();
	const unconfirmed = (reason: OwnedProcessShutdownBlockers["reason"]): RuntimeOwnedProcessShutdownOutcome => {
		const blockers: OwnedProcessShutdownBlockers["blockers"] = [];
		let blockerCount = 0;
		const append = (blocker: OwnedProcessShutdownBlockers["blockers"][number]) => {
			blockerCount++;
			if (blockers.length < 20) blockers.push(blocker);
		};
		for (const target of targets ?? []) {
			const current = observed.get(target.pid);
			if (
				!current ||
				current.zombie ||
				(target.creationIdentity && current.creationIdentity && !sameIdentity(target, current))
			)
				continue;
			append({
				pid: target.pid,
				parentPid: target.parentPid,
				observedParentPid: current.parentPid,
				identityPresent: Boolean(target.creationIdentity && current.creationIdentity),
				preciseIdentity: target.preciseIdentity,
				reason:
					reason === "snapshot_failed"
						? reason
						: !target.creationIdentity || !current.creationIdentity
							? "identity_unavailable"
							: !target.preciseIdentity && current.parentPid !== target.parentPid
								? "ancestry_changed"
								: "still_live",
			});
		}
		for (const pid of targets ? unverifiedRoots : (originalRoots ?? [])) {
			append({
				pid,
				parentPid: null,
				observedParentPid: null,
				identityPresent: false,
				preciseIdentity: false,
				reason: reason === "snapshot_failed" ? reason : "root_unverified",
			});
		}
		try {
			options.onUnconfirmed?.({
				reason,
				targetCount: targets?.length ?? 0,
				coverageUncertain: uncertain,
				blockerCount,
				blockers,
			});
		} catch {
			/* Diagnostics cannot change cleanup authority or settlement. */
		}
		return { status: "unconfirmed" };
	};
	const attempt = async (stopSessions: () => void): Promise<RuntimeOwnedProcessShutdownOutcome> => {
		if (!originalRoots) {
			originalRoots = new Set(options.getRootPids());
			uncertain = options.hasPendingLaunches?.() ?? false;
		}
		if (!targets) {
			try {
				const rows = await snapshot();
				const currentRoots = new Set(options.getRootPids());
				if (currentRoots.size !== originalRoots.size || [...currentRoots].some((pid) => !originalRoots?.has(pid))) {
					uncertain = true;
				}
				const runtime = rows.find((row) => row.pid === runtimePid);
				if (options.includeRuntimeChildren) {
					if (!runtime?.creationIdentity || !runtime.birthTime) uncertain = true;
					for (const row of rows) {
						if (row.parentPid === runtimePid && ancestry(runtime, row) !== "foreign") originalRoots.add(row.pid);
					}
				}
				const verifiedRoots = new Set<number>();
				for (const pid of originalRoots) {
					const root = rows.find((row) => row.pid === pid);
					if (!root || pid === runtimePid || ancestry(runtime, root) !== "verified") {
						uncertain = true;
						unverifiedRoots.add(pid);
						continue;
					}
					verifiedRoots.add(pid);
				}
				const forest = selectForest(rows, verifiedRoots);
				targets = forest.owned;
				if (forest.possible.length !== forest.owned.length) uncertain = true;
				observed = new Map(targets.map((row) => [row.pid, row]));
			} catch {
				// Without a full initial snapshot even unknown direct runtime children
				// may have orphaned. No later empty root list can repair that gap.
				uncertain = true;
				stopSessions();
				return unconfirmed("snapshot_failed");
			}
		}
		// Lifecycle semantics precede signals, but process disposal belongs here alone.
		stopSessions();
		const startedAt = Date.now();
		const timeoutMs = options.timeoutMs ?? 4_000;
		const graceMs = options.graceMs ?? 500;
		const termSent = new Set<number>();
		const killSent = new Set<number>();
		while (true) {
			let rows: OwnedProcessSnapshot[];
			try {
				rows = await snapshot();
			} catch {
				return unconfirmed("snapshot_failed");
			}
			const byPid = new Map(rows.map((row) => [row.pid, row]));
			// Adopt children forked during shutdown only from still-identical owned parents.
			const liveOwned = new Set(
				targets
					.filter((target) => {
						const row = byPid.get(target.pid);
						return (
							Boolean(target.creationIdentity) &&
							row !== undefined &&
							sameIdentity(target, row) &&
							(target.preciseIdentity || row.parentPid === target.parentPid)
						);
					})
					.map((target) => target.pid),
			);
			const forest = selectForest(rows, liveOwned);
			if (forest.possible.length !== forest.owned.length) uncertain = true;
			for (const row of forest.owned) {
				if (!targets.some((target) => sameIdentity(target, row))) targets.push(row);
			}
			observed = new Map(
				targets.flatMap((target) => {
					const current = byPid.get(target.pid);
					return current ? [[current.pid, current] as const] : [];
				}),
			);
			let remaining = false;
			for (const target of targets) {
				const current = byPid.get(target.pid);
				if (current && (!target.creationIdentity || !current.creationIdentity)) {
					uncertain = true;
					remaining = true;
					continue;
				}
				if (!current || !sameIdentity(target, current) || current.zombie) continue;
				remaining = true;
				// Coarse BSD birth times cannot safely authorize a reparented/recycled PID.
				if (!target.preciseIdentity && current.parentPid !== target.parentPid) {
					if (
						selectForest(rows, new Set([target.pid])).possible.some(
							(row) => !row.zombie && !targets?.some((captured) => sameIdentity(captured, row)),
						)
					)
						uncertain = true;
					continue;
				}
				// A signal is not exit confirmation. Keep parents alive until the next
				// snapshot proves every descendant stopped, including TERM-resistant ones.
				if (
					selectForest(rows, new Set([target.pid])).possible.some((row) => row.pid !== target.pid && !row.zombie)
				) {
					continue;
				}
				const force = Date.now() - startedAt >= graceMs;
				const sent = force ? killSent : termSent;
				if (sent.has(target.pid)) continue;
				try {
					signal(target.pid, force ? "SIGKILL" : "SIGTERM");
					sent.add(target.pid);
				} catch {
					/* Absence is proved by the next snapshot, never by a failed signal. */
				}
			}
			if (!remaining) return uncertain ? unconfirmed("coverage_gap") : { status: "stopped" };
			if (Date.now() - startedAt >= timeoutMs) return unconfirmed("deadline");
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	};
	return (stopSessions) => {
		if (stopped) return Promise.resolve({ status: "stopped" });
		inFlight ??= Promise.resolve()
			.then(() => attempt(stopSessions))
			.then(
				(result) => {
					stopped = result.status === "stopped";
					inFlight = undefined;
					return result;
				},
				(error: unknown) => {
					inFlight = undefined;
					throw error;
				},
			);
		return inFlight;
	};
}

/** One-shot cleanup. Runtime lifetime owners must reuse the factory across retries. */
export async function stopRuntimeOwnedProcessTrees(
	options: StopRuntimeOwnedProcessTreesOptions,
): Promise<RuntimeOwnedProcessShutdownOutcome> {
	return await createRuntimeOwnedProcessShutdown(options)(options.stopSessions);
}
