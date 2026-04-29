// Detects and kills orphaned agent processes (Claude, Codex, Pi) left behind by a
// crashed Quarterdeck instance. Runs at startup and shutdown.

import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";

import treeKill from "tree-kill";

import { createTaggedLogger } from "../core";
import { isProcessAlive } from "./process-liveness";

const log = createTaggedLogger("orphan-cleanup");

const AGENT_PROCESS_NAMES = ["claude", "codex", "pi"];
const WINDOWS_AGENT_HOST_PROCESS_NAMES = new Set(["cmd", "node", "powershell", "pwsh"]);
const WINDOWS_AGENT_COMMAND_PATTERNS: Array<{ agentName: string; pattern: RegExp }> = [
	{
		agentName: "claude",
		pattern: /(?:^|[\\/=\s"'])(?:claude|claude-code)(?:\.(?:cmd|bat|js|mjs|cjs|exe))?(?=$|[\\/=\s"'])/iu,
	},
	{
		agentName: "codex",
		pattern: /(?:^|[\\/=\s"'])codex(?:\.(?:cmd|bat|js|mjs|cjs|exe))?(?=$|[\\/=\s"'])/iu,
	},
	{
		agentName: "pi",
		pattern: /(?:^|[\\/=\s"'])pi(?:\.(?:cmd|bat|js|mjs|cjs|exe))?(?=$|[\\/=\s"'])/iu,
	},
];

/** Grace period after SIGTERM before escalating to SIGKILL. */
const SIGTERM_GRACE_MS = 3_000;
const SIGTERM_POLL_MS = 500;

type KillProcessTree = (pid: number, signal?: string | number, callback?: (error?: Error) => void) => void;

export interface OrphanProcessListResult {
	ok: boolean;
	stdout: string;
}

export type OrphanProcessListRunner = () => Promise<OrphanProcessListResult>;

export interface FindOrphanedAgentPidsOptions {
	platform?: NodeJS.Platform;
	runPsCommand?: OrphanProcessListRunner;
}

export interface KillOrphanedAgentProcessesOptions {
	platform?: NodeJS.Platform;
	findPids?: () => Promise<number[]>;
	killProcess?: (pid: number) => Promise<boolean>;
	killProcessTree?: KillProcessTree;
}

interface OrphanProcessCandidate {
	pid: number;
	ppid: number;
	command: string;
	commandLine?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Finds agent processes whose parent is gone. On Unix, orphaned processes are
 * reparented to PID 1. On Windows, Win32_Process keeps the original parent pid,
 * so the PowerShell query filters for a missing or pid-reused parent.
 */
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

function buildWindowsOrphanProcessScript(): string {
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		`$currentPid = ${process.pid}`,
		"$processes = @(Get-CimInstance Win32_Process)",
		"$byPid = @{}",
		"foreach ($process in $processes) { $processId = [int]$process.ProcessId; $byPid[$processId] = $process }",
		"$rows = @(" +
			"foreach ($process in $processes) { " +
			"if ([int]$process.ProcessId -eq $currentPid) { continue }; " +
			"$parentId = [int]$process.ParentProcessId; " +
			"$parent = $byPid[$parentId]; " +
			"$orphaned = $null -eq $parent; " +
			"if (-not $orphaned -and $process.CreationDate -and $parent.CreationDate) { " +
			"$orphaned = [datetime]$parent.CreationDate -gt [datetime]$process.CreationDate " +
			"}; " +
			"if ($orphaned) { " +
			"[pscustomobject]@{ pid = [int]$process.ProcessId; ppid = $parentId; command = [string]$process.Name; commandLine = [string]$process.CommandLine } " +
			"} " +
			"}" +
			")",
		"ConvertTo-Json -InputObject $rows -Compress",
	].join("; ");
}

async function defaultRunWindowsProcessListCommand(): Promise<OrphanProcessListResult> {
	const args = [
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		buildWindowsOrphanProcessScript(),
	];
	const windowsPowerShellResult = await runExecFile("powershell.exe", args);
	if (windowsPowerShellResult.ok) {
		return windowsPowerShellResult;
	}
	return await runExecFile("pwsh.exe", args);
}

function defaultRunProcessListCommand(platform: NodeJS.Platform): Promise<OrphanProcessListResult> {
	if (platform === "win32") {
		return defaultRunWindowsProcessListCommand();
	}
	return defaultRunUnixProcessListCommand();
}

function normalizeAgentProcessName(command: string): string {
	const basename = command.trim().split(/[\\/]/u).pop()?.toLowerCase() ?? "";
	return basename.replace(/\.(exe|cmd|bat)$/iu, "");
}

function inferAgentNameFromWindowsCommandLine(commandLine: string | undefined): string | null {
	if (!commandLine) {
		return null;
	}
	for (const { agentName, pattern } of WINDOWS_AGENT_COMMAND_PATTERNS) {
		if (pattern.test(commandLine)) {
			return agentName;
		}
	}
	return null;
}

function resolveAgentProcessName(
	command: string,
	commandLine: string | undefined,
	platform: NodeJS.Platform,
): string | null {
	const basename = normalizeAgentProcessName(command);
	if (AGENT_PROCESS_NAMES.includes(basename)) {
		return basename;
	}
	if (platform !== "win32" || !WINDOWS_AGENT_HOST_PROCESS_NAMES.has(basename)) {
		return null;
	}
	return inferAgentNameFromWindowsCommandLine(commandLine);
}

function isOrphanedProcessLine(ppid: number, platform: NodeJS.Platform): boolean {
	if (platform === "win32") {
		// The default Windows command emits only parentless or pid-reused-parent
		// rows; injected test runners follow that same pre-filtered contract.
		return Number.isFinite(ppid);
	}
	return ppid === 1;
}

function readNumberField(record: Record<string, unknown>, field: string): number | null {
	const value = record[field];
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function readStringField(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseWindowsProcessCandidates(stdout: string): OrphanProcessCandidate[] {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [];
	}

	const records = Array.isArray(parsed) ? parsed : [parsed];
	const candidates: OrphanProcessCandidate[] = [];
	for (const record of records) {
		if (!isRecord(record)) {
			continue;
		}
		const pid = readNumberField(record, "pid");
		const ppid = readNumberField(record, "ppid");
		const command = readStringField(record, "command").trim();
		if (pid === null || ppid === null || !command) {
			continue;
		}
		candidates.push({
			pid,
			ppid,
			command,
			commandLine: readStringField(record, "commandLine"),
		});
	}
	return candidates;
}

function parseUnixProcessCandidates(stdout: string): OrphanProcessCandidate[] {
	const candidates: OrphanProcessCandidate[] = [];
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		if (!match) continue;

		const pid = Number(match[1]);
		const ppid = Number(match[2]);
		const command = match[3]?.trim();
		if (!command) continue;

		candidates.push({ pid, ppid, command });
	}
	return candidates;
}

function parseProcessCandidates(stdout: string, platform: NodeJS.Platform): OrphanProcessCandidate[] {
	if (platform === "win32") {
		return parseWindowsProcessCandidates(stdout);
	}
	return parseUnixProcessCandidates(stdout);
}

export async function findOrphanedAgentPids(options: FindOrphanedAgentPidsOptions = {}): Promise<number[]> {
	const platform = options.platform ?? process.platform;
	const result = await (options.runPsCommand ?? (() => defaultRunProcessListCommand(platform)))();
	if (!result.ok) return [];

	const pids: number[] = [];
	for (const { pid, ppid, command, commandLine } of parseProcessCandidates(result.stdout, platform)) {
		if (!isOrphanedProcessLine(ppid, platform)) continue;
		if (pid === process.pid) continue;
		if (resolveAgentProcessName(command, commandLine, platform) === null) continue;

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
		return await killWindowsPid(pid, options.killProcessTree ?? treeKill);
	}

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
export async function killOrphanedAgentProcesses(options: KillOrphanedAgentProcessesOptions = {}): Promise<number> {
	const findPids = options.findPids ?? (() => findOrphanedAgentPids({ platform: options.platform }));
	const pids = await findPids();
	if (pids.length === 0) return 0;

	log.warn("found orphaned agent processes", { pids });

	let killed = 0;
	const killProcess =
		options.killProcess ??
		((pid: number) =>
			killPid(pid, {
				platform: options.platform,
				killProcessTree: options.killProcessTree,
			}));
	for (const pid of pids) {
		const success = await killProcess(pid);
		if (success) {
			killed++;
			log.warn("killed orphaned agent process", { pid });
		} else {
			log.error("failed to kill orphaned agent process", { pid });
		}
	}

	return killed;
}
