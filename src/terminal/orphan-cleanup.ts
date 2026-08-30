// Cleans agent processes left behind by a crashed Quarterdeck runtime. Unix
// retains its PID-1 fallback; Windows is authorized exclusively by durable,
// launch-scoped ownership records with exact PID creation evidence.

import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";

import { createTaggedLogger, type KillProcessTree, terminateWindowsProcessTree } from "../core";
import {
	type AbandonedManagedProcess,
	discoverAbandonedManagedProcesses,
	retireManagedProcessOwnership,
	verifyAbandonedManagedProcess,
} from "./managed-process-ownership";
import { isProcessAlive } from "./process-liveness";

const log = createTaggedLogger("orphan-cleanup");
const AGENT_PROCESS_NAMES = ["claude", "codex", "pi"];

/** Grace period after SIGTERM before escalating to SIGKILL. */
const SIGTERM_GRACE_MS = 3_000;
const SIGTERM_POLL_MS = 500;

export interface OrphanProcessListResult {
	ok: boolean;
	stdout: string;
}

export type OrphanProcessListRunner = () => Promise<OrphanProcessListResult>;

export interface FindOrphanedAgentPidsOptions {
	platform?: NodeJS.Platform;
	runPsCommand?: OrphanProcessListRunner;
	findManagedProcesses?: () => Promise<AbandonedManagedProcess[]>;
}

export interface KillOrphanedAgentProcessesOptions {
	platform?: NodeJS.Platform;
	includeCurrentRuntime?: boolean;
	findPids?: () => Promise<number[]>;
	findManagedProcesses?: () => Promise<AbandonedManagedProcess[]>;
	verifyManagedProcess?: (candidate: AbandonedManagedProcess) => Promise<boolean>;
	retireManagedProcess?: typeof retireManagedProcessOwnership;
	killProcess?: (pid: number) => Promise<boolean>;
	killProcessTree?: KillProcessTree;
}

interface UnixOrphanProcessCandidate {
	pid: number;
	ppid: number;
	command: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function runExecFile(command: string, args: string[]): Promise<OrphanProcessListResult> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				encoding: "utf8",
				timeout: 5_000,
			},
			(error: ExecFileException | null, stdout: string | Buffer) => {
				resolve({
					ok: !error,
					stdout: String(stdout ?? ""),
				});
			},
		);
	});
}

function defaultRunUnixProcessListCommand(): Promise<OrphanProcessListResult> {
	return runExecFile("ps", ["-eo", "pid=,ppid=,comm="]);
}

function normalizeAgentProcessName(command: string): string {
	const basename = command.trim().split(/[\\/]/u).pop()?.toLowerCase() ?? "";
	return basename.replace(/\.(exe|cmd|bat)$/iu, "");
}

function parseUnixProcessCandidates(stdout: string): UnixOrphanProcessCandidate[] {
	const candidates: UnixOrphanProcessCandidate[] = [];
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
		if (!match) continue;
		const pid = Number(match[1]);
		const ppid = Number(match[2]);
		const command = match[3]?.trim();
		if (command) candidates.push({ pid, ppid, command });
	}
	return candidates;
}

/**
 * Finds cleanup candidates. Windows deliberately ignores global process names
 * and command lines; only protected Quarterdeck launch records can authorize a
 * result.
 */
export async function findOrphanedAgentPids(options: FindOrphanedAgentPidsOptions = {}): Promise<number[]> {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		const candidates = await (options.findManagedProcesses ?? (() => discoverAbandonedManagedProcesses()))();
		return candidates.map((candidate) => candidate.identity.pid);
	}

	const result = await (options.runPsCommand ?? defaultRunUnixProcessListCommand)();
	if (!result.ok) return [];
	const pids: number[] = [];
	for (const { pid, ppid, command } of parseUnixProcessCandidates(result.stdout)) {
		if (ppid !== 1 || pid === process.pid) continue;
		if (!AGENT_PROCESS_NAMES.includes(normalizeAgentProcessName(command))) continue;
		pids.push(pid);
	}
	return pids;
}

async function killWindowsPid(pid: number, killProcessTree: KillProcessTree): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			killProcessTree(pid, "SIGTERM", (error?: Error) => {
				if (!error) {
					resolve(true);
					return;
				}
				resolve(!isProcessAlive(pid));
			});
		} catch {
			resolve(!isProcessAlive(pid));
		}
	});
}

async function killPid(
	pid: number,
	options: { platform?: NodeJS.Platform; killProcessTree?: KillProcessTree } = {},
): Promise<boolean> {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		return await killWindowsPid(pid, options.killProcessTree ?? terminateWindowsProcessTree);
	}

	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return true;
	}
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

async function retireCandidateRecords(
	candidate: AbandonedManagedProcess,
	retire: typeof retireManagedProcessOwnership,
): Promise<void> {
	await Promise.all(candidate.records.map(async (record) => await retire(record).catch(() => undefined)));
}

async function cleanupWindowsManagedProcesses(options: KillOrphanedAgentProcessesOptions): Promise<number> {
	const candidates = await (
		options.findManagedProcesses ??
		(() => discoverAbandonedManagedProcesses({ includeCurrentRuntime: options.includeCurrentRuntime }))
	)();
	if (candidates.length === 0) return 0;

	log.warn("found abandoned Quarterdeck-managed process trees", {
		pids: candidates.map((candidate) => candidate.identity.pid),
	});
	const verify = options.verifyManagedProcess ?? verifyAbandonedManagedProcess;
	const retire = options.retireManagedProcess ?? retireManagedProcessOwnership;
	const killProcess =
		options.killProcess ??
		((pid: number) =>
			killPid(pid, {
				platform: "win32",
				killProcessTree: options.killProcessTree,
			}));

	let killed = 0;
	for (const candidate of candidates) {
		if (!(await verify(candidate))) {
			await retireCandidateRecords(candidate, retire);
			log.warn("skipped managed process cleanup after PID identity changed", { pid: candidate.identity.pid });
			continue;
		}
		if (await killProcess(candidate.identity.pid)) {
			killed++;
			await retireCandidateRecords(candidate, retire);
			log.warn("killed abandoned Quarterdeck-managed process tree", { pid: candidate.identity.pid });
		} else {
			log.error("failed to kill abandoned Quarterdeck-managed process tree", { pid: candidate.identity.pid });
		}
	}
	return killed;
}

/** Finds and kills orphaned agent processes. Safe to call at startup and shutdown. */
export async function killOrphanedAgentProcesses(options: KillOrphanedAgentProcessesOptions = {}): Promise<number> {
	const platform = options.platform ?? process.platform;
	if (platform === "win32" && !options.findPids) {
		return await cleanupWindowsManagedProcesses(options);
	}

	const pids = await (options.findPids ?? (() => findOrphanedAgentPids({ platform })))();
	if (pids.length === 0) return 0;
	log.warn("found orphaned agent processes", { pids });

	const killProcess =
		options.killProcess ??
		((pid: number) =>
			killPid(pid, {
				platform,
				killProcessTree: options.killProcessTree,
			}));
	let killed = 0;
	for (const pid of pids) {
		if (await killProcess(pid)) {
			killed++;
			log.warn("killed orphaned agent process", { pid });
		} else {
			log.error("failed to kill orphaned agent process", { pid });
		}
	}
	return killed;
}
