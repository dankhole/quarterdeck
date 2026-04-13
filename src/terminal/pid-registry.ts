// Persistent PID registry for agent processes spawned by Quarterdeck.
//
// On clean shutdown, all processes are killed and the registry is cleared.
// After an unclean exit (crash, force-kill, OOM), the registry survives on disk
// so the next startup can find and kill orphaned agent processes.
//
// The registry lives at ~/.quarterdeck/managed-pids.json. Entries are added on
// spawn and removed on exit. A startup sweep kills anything left over, and a
// periodic sweep (called from the reconciliation timer) catches stragglers.

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createTaggedLogger } from "../core/debug-logger";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { isProcessAlive } from "./session-reconciliation";

const log = createTaggedLogger("pid-registry");

const REGISTRY_FILENAME = "managed-pids.json";

/** How long to wait for SIGTERM before escalating to SIGKILL. */
const SIGTERM_GRACE_MS = 3_000;
const SIGTERM_POLL_INTERVAL_MS = 500;

/** How far apart spawnedAt and actual process start time can be before we suspect PID reuse. */
const PID_REUSE_TOLERANCE_MS = 30_000;

export interface ManagedPidEntry {
	taskId: string;
	agentId: string;
	spawnedAt: number;
}

type PidRegistry = Record<string, ManagedPidEntry>;

export interface SweepResult {
	checked: number;
	killed: number;
	stale: number;
	skipped: number;
}

function getRegistryPath(): string {
	return join(getRuntimeHomePath(), REGISTRY_FILENAME);
}

async function loadRegistry(): Promise<PidRegistry> {
	try {
		const raw = await readFile(getRegistryPath(), "utf-8");
		return JSON.parse(raw) as PidRegistry;
	} catch {
		return {};
	}
}

async function saveRegistry(registry: PidRegistry): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getRegistryPath(), registry, { lock: null });
}

// Serialize all read-modify-write operations through an in-memory queue.
// Multiple concurrent spawns/exits would otherwise race on the same file.
let pendingOp: Promise<void> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const op = pendingOp.then(fn, fn);
	pendingOp = op.then(
		() => {},
		() => {},
	);
	return op;
}

export function registerManagedPid(pid: number, entry: ManagedPidEntry): Promise<void> {
	return serialized(async () => {
		const registry = await loadRegistry();
		registry[String(pid)] = entry;
		await saveRegistry(registry);
	});
}

export function unregisterManagedPid(pid: number): Promise<void> {
	return serialized(async () => {
		const registry = await loadRegistry();
		const key = String(pid);
		if (!(key in registry)) return;
		delete registry[key];
		await saveRegistry(registry);
	});
}

export function clearPidRegistry(): Promise<void> {
	return serialized(async () => {
		await saveRegistry({});
	});
}

// ---------------------------------------------------------------------------
// Process start-time check (guards against PID reuse after reboot / long gap)
// ---------------------------------------------------------------------------

/**
 * Returns the process start time as a Unix ms timestamp, or null if it can't
 * be determined. Used to detect PID reuse: if the OS says the process started
 * at a very different time than our `spawnedAt`, the PID was recycled.
 */
function getProcessStartTimeMs(pid: number): number | null {
	if (process.platform === "win32") return null;
	try {
		const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf-8",
			timeout: 2_000,
		});
		if (result.status !== 0 || !result.stdout.trim()) return null;
		const parsed = new Date(result.stdout.trim()).getTime();
		return Number.isNaN(parsed) ? null : parsed;
	} catch {
		return null;
	}
}

function isPidReuse(entry: ManagedPidEntry, pid: number): boolean {
	const startTime = getProcessStartTimeMs(pid);
	if (startTime == null) return false; // Can't determine — assume it's ours.
	return Math.abs(startTime - entry.spawnedAt) > PID_REUSE_TOLERANCE_MS;
}

// ---------------------------------------------------------------------------
// Kill + verify
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends SIGTERM to a process (and its process group), waits for it to die,
 * then escalates to SIGKILL if needed. Returns true if the process is dead.
 */
async function killAndVerify(pid: number): Promise<boolean> {
	// SIGTERM
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return true; // ESRCH — already dead
	}
	// Also signal the process group (PTY children)
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// Best effort
		}
	}

	// Poll for exit
	const polls = Math.ceil(SIGTERM_GRACE_MS / SIGTERM_POLL_INTERVAL_MS);
	for (let i = 0; i < polls; i++) {
		await sleep(SIGTERM_POLL_INTERVAL_MS);
		if (!isProcessAlive(pid)) return true;
	}

	// Escalate to SIGKILL
	log.warn("process did not exit after SIGTERM, escalating to SIGKILL", { pid });
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		return true;
	}
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Best effort
		}
	}

	await sleep(SIGTERM_POLL_INTERVAL_MS);
	return !isProcessAlive(pid);
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/**
 * Startup sweep: kills all orphaned processes in the registry.
 * Runs through the serialization queue so it's safe to call concurrently
 * with register/unregister (e.g. when the sweep runs in the background
 * while new sessions are already starting).
 */
export function sweepOrphanedPids(): Promise<SweepResult> {
	return serialized(async () => {
		const registry = await loadRegistry();
		const pids = Object.keys(registry);
		const result: SweepResult = { checked: 0, killed: 0, stale: 0, skipped: 0 };

		if (pids.length === 0) return result;

		log.info("startup sweep: checking orphaned PIDs", { count: pids.length });

		const survivors: PidRegistry = {};

		for (const pidStr of pids) {
			result.checked++;
			const pid = Number(pidStr);
			const entry = registry[pidStr];

			if (!isProcessAlive(pid)) {
				result.stale++;
				continue;
			}

			if (isPidReuse(entry, pid)) {
				log.info("skipping recycled PID", { pid, taskId: entry.taskId });
				result.skipped++;
				continue;
			}

			log.warn("killing orphaned agent process", { pid, taskId: entry.taskId, agentId: entry.agentId });
			const killed = await killAndVerify(pid);
			if (killed) {
				result.killed++;
			} else {
				log.error("failed to kill orphaned process", { pid });
				survivors[pidStr] = entry;
			}
		}

		// Save only the survivors (processes that resisted kill). Everything else
		// is accounted for: dead, killed, recycled, or stale.
		await saveRegistry(survivors);

		if (result.killed > 0 || result.stale > 0) {
			log.info("startup sweep complete", result);
		}

		return result;
	});
}

/**
 * Periodic sweep: called from the reconciliation timer to catch PIDs that
 * escaped normal exit handling (e.g. onExit callback didn't fire).
 *
 * @param activePids - PIDs currently managed by the session manager (skip these)
 */
export function periodicPidSweep(activePids: Set<number>): Promise<SweepResult> {
	return serialized(async () => {
		const registry = await loadRegistry();
		const result: SweepResult = { checked: 0, killed: 0, stale: 0, skipped: 0 };
		const toRemove: string[] = [];

		for (const [pidStr, entry] of Object.entries(registry)) {
			const pid = Number(pidStr);

			// Skip PIDs actively managed by this server instance.
			if (activePids.has(pid)) continue;

			result.checked++;

			if (!isProcessAlive(pid)) {
				toRemove.push(pidStr);
				result.stale++;
				continue;
			}

			// Alive but not managed — orphan.
			log.warn("periodic sweep: killing unmanaged agent process", {
				pid,
				taskId: entry.taskId,
				agentId: entry.agentId,
			});
			const killed = await killAndVerify(pid);
			if (killed) {
				toRemove.push(pidStr);
				result.killed++;
			} else {
				log.error("periodic sweep: failed to kill process, will retry next sweep", { pid });
			}
		}

		if (toRemove.length > 0) {
			for (const pid of toRemove) {
				delete registry[pid];
			}
			await saveRegistry(registry);
		}

		return result;
	});
}
