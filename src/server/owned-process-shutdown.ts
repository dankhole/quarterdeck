import type { RuntimeOwnedProcessShutdownOutcome } from "../core/api/runtime-shutdown.js";
import { type OwnedProcessSnapshot, queryOwnedProcessSnapshot } from "./owned-process-snapshot.js";

export interface StopRuntimeOwnedProcessTreesOptions {
	getRootPids: () => readonly number[];
	stopSessions: () => void;
	hasPendingLaunches?: () => boolean;
	/** Production includes other direct runtime children (structured providers/LSPs). */
	includeRuntimeChildren?: boolean;
	runtimePid?: number;
	graceMs?: number;
	timeoutMs?: number;
	snapshot?: () => Promise<OwnedProcessSnapshot[]>;
	signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}

function sameIdentity(left: OwnedProcessSnapshot, right: OwnedProcessSnapshot): boolean {
	return left.pid === right.pid && left.creationIdentity === right.creationIdentity;
}

function selectForest(rows: readonly OwnedProcessSnapshot[], rootPids: ReadonlySet<number>): OwnedProcessSnapshot[] {
	const selected = new Set(rootPids);
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const row of rows) {
			if (!selected.has(row.pid) && selected.has(row.parentPid)) {
				selected.add(row.pid);
				expanded = true;
			}
		}
	}
	return rows.filter((row) => selected.has(row.pid));
}

/** Snapshot live ownership before lifecycle stop, then confirm exact roots and descendants. */
export async function stopRuntimeOwnedProcessTrees(
	options: StopRuntimeOwnedProcessTreesOptions,
): Promise<RuntimeOwnedProcessShutdownOutcome> {
	const snapshot = options.snapshot ?? queryOwnedProcessSnapshot;
	const signal = options.signal ?? ((pid, name) => process.kill(pid, name));
	const runtimePid = options.runtimePid ?? process.pid;
	const originalRoots = new Set(options.getRootPids());
	let uncertain = options.hasPendingLaunches?.() ?? false;
	let targets: OwnedProcessSnapshot[];
	try {
		const rows = await snapshot();
		const currentRoots = new Set(options.getRootPids());
		if (currentRoots.size !== originalRoots.size || [...currentRoots].some((pid) => !originalRoots.has(pid))) {
			uncertain = true;
		}
		if (options.includeRuntimeChildren) {
			for (const row of rows) if (row.parentPid === runtimePid) originalRoots.add(row.pid);
		}
		const verifiedRoots = new Set<number>();
		for (const pid of originalRoots) {
			const root = rows.find((row) => row.pid === pid);
			if (!root) {
				uncertain = true;
				continue;
			}
			if (pid === runtimePid || root.parentPid !== runtimePid) {
				uncertain = true;
				continue;
			}
			verifiedRoots.add(pid);
		}
		targets = selectForest(rows, verifiedRoots);
	} catch {
		options.stopSessions();
		return { status: "unconfirmed" };
	}
	// This authors Interrupted/recovery meaning before any process receives a signal.
	options.stopSessions();
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
			return { status: "unconfirmed" };
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
		for (const row of selectForest(rows, liveOwned)) {
			if (!targets.some((target) => sameIdentity(target, row))) targets.push(row);
		}
		let remaining = false;
		for (const target of [...targets].reverse()) {
			const current = byPid.get(target.pid);
			if (!target.creationIdentity && current) {
				uncertain = true;
				remaining = true;
				continue;
			}
			if (!current || !sameIdentity(target, current) || current.zombie) continue;
			remaining = true;
			// Coarse BSD birth times cannot safely authorize a reparented/recycled PID.
			if (!target.preciseIdentity && current.parentPid !== target.parentPid) {
				uncertain = true;
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
		if (!remaining) return { status: uncertain ? "unconfirmed" : "stopped" };
		if (Date.now() - startedAt >= timeoutMs) return { status: "unconfirmed" };
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}
