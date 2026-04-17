// Detects and kills orphaned agent processes (Claude, Codex) left behind by a
// crashed Quarterdeck instance. Orphaned processes have PPID=1 (reparented to
// init/launchd after their parent died). Runs at startup and shutdown.

import { spawnSync } from "node:child_process";

import { createTaggedLogger } from "../core";
import { isProcessAlive } from "./session-reconciliation";

const log = createTaggedLogger("orphan-cleanup");

const AGENT_PROCESS_NAMES = ["claude", "codex"];

/** Grace period after SIGTERM before escalating to SIGKILL. */
const SIGTERM_GRACE_MS = 3_000;
const SIGTERM_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Finds agent processes whose parent is PID 1 (orphaned after their
 * Quarterdeck parent crashed). Returns their PIDs.
 */
function findOrphanedAgentPids(): number[] {
	if (process.platform === "win32") return [];

	const result = spawnSync("ps", ["-eo", "pid=,ppid=,comm="], {
		encoding: "utf-8",
		timeout: 5_000,
	});
	if (result.status !== 0) return [];

	const pids: number[] = [];
	for (const line of result.stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		if (!match) continue;

		const pid = Number(match[1]);
		const ppid = Number(match[2]);
		const comm = match[3].trim();

		if (ppid !== 1) continue;
		if (pid === process.pid) continue;
		const basename = comm.split("/").pop() ?? comm;
		if (!AGENT_PROCESS_NAMES.includes(basename)) continue;

		pids.push(pid);
	}

	return pids;
}

async function killPid(pid: number): Promise<boolean> {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return true;
	}

	// Also signal the process group (PTY children).
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		// Best effort.
	}

	const polls = Math.ceil(SIGTERM_GRACE_MS / SIGTERM_POLL_MS);
	for (let i = 0; i < polls; i++) {
		await sleep(SIGTERM_POLL_MS);
		if (!isProcessAlive(pid)) return true;
	}

	// Escalate to SIGKILL.
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		return true;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Best effort.
	}

	await sleep(SIGTERM_POLL_MS);
	return !isProcessAlive(pid);
}

/**
 * Finds and kills orphaned agent processes. Returns the number killed.
 * Safe to call at both startup and shutdown.
 */
export async function killOrphanedAgentProcesses(): Promise<number> {
	const pids = findOrphanedAgentPids();
	if (pids.length === 0) return 0;

	log.warn("found orphaned agent processes", { pids });

	let killed = 0;
	for (const pid of pids) {
		const success = await killPid(pid);
		if (success) {
			killed++;
			log.warn("killed orphaned agent process", { pid });
		} else {
			log.error("failed to kill orphaned agent process", { pid });
		}
	}

	return killed;
}
