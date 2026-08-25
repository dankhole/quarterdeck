import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import treeKill from "tree-kill";

import { isProcessAlive } from "./paths";

const PROCESS_LIST_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 3_000;
const TERMINATION_POLL_MS = 100;

interface ProcessRecord {
	pid: number;
	ppid: number;
	commandLine: string;
}

interface ProcessListResult {
	ok: boolean;
	stdout: string;
}

export interface AgentLabBrowserProcessTree {
	rootPids: number[];
	processPids: number[];
}

type KillProcessTree = (pid: number, signal?: string | number, callback?: (error?: Error) => void) => void;

interface FindAgentLabBrowserProcessTreeOptions {
	platform?: NodeJS.Platform;
	resolveDaemonEntrypoint?: (repoRoot: string) => string;
	runProcessList?: () => Promise<ProcessListResult>;
}

interface TerminateAgentLabBrowserProcessTreeOptions {
	platform?: NodeJS.Platform;
	killProcessTree?: KillProcessTree;
	isAlive?: (pid: number) => boolean;
	signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
	wait?: (milliseconds: number) => Promise<void>;
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runExecFile(command: string, args: string[]): Promise<ProcessListResult> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{ encoding: "utf8", timeout: PROCESS_LIST_TIMEOUT_MS },
			(error: ExecFileException | null, stdout: string | Buffer) => {
				resolve({ ok: !error, stdout: String(stdout ?? "") });
			},
		);
	});
}

function buildWindowsProcessListScript(): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		"$rows = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; commandLine = [string]$_.CommandLine } })",
		"ConvertTo-Json -InputObject $rows -Compress",
	].join("; ");
}

async function defaultRunProcessList(platform: NodeJS.Platform): Promise<ProcessListResult> {
	if (platform === "win32") {
		const args = [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			buildWindowsProcessListScript(),
		];
		const windowsPowerShell = await runExecFile("powershell.exe", args);
		return windowsPowerShell.ok ? windowsPowerShell : await runExecFile("pwsh.exe", args);
	}
	return await runExecFile("ps", ["-ax", "-o", "pid=,ppid=,command="]);
}

function readNumberField(record: Record<string, unknown>, field: string): number | null {
	const value = record[field];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseWindowsProcessList(stdout: string): ProcessRecord[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [];
	}
	const records = Array.isArray(parsed) ? parsed : [parsed];
	const processes: ProcessRecord[] = [];
	for (const value of records) {
		if (typeof value !== "object" || value === null) continue;
		const record = value as Record<string, unknown>;
		const pid = readNumberField(record, "pid");
		const ppid = readNumberField(record, "ppid");
		const commandLine = typeof record.commandLine === "string" ? record.commandLine.trim() : "";
		if (pid === null || ppid === null || !commandLine) continue;
		processes.push({ pid, ppid, commandLine });
	}
	return processes;
}

function parseUnixProcessList(stdout: string): ProcessRecord[] {
	const processes: ProcessRecord[] = [];
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
		if (!match) continue;
		const pid = Number(match[1]);
		const ppid = Number(match[2]);
		const commandLine = match[3]?.trim();
		if (!commandLine) continue;
		processes.push({ pid, ppid, commandLine });
	}
	return processes;
}

function resolveModuleFrom(specifier: string, parentPath: string): string {
	return createRequire(parentPath).resolve(specifier);
}

function resolvePlaywrightDaemonEntrypoint(
	repoRoot: string,
	resolveModule: (specifier: string, parentPath: string) => string = resolveModuleFrom,
): string {
	const webPackagePath = join(repoRoot, "web-ui", "package.json");
	const cliPackagePath = resolveModule("@playwright/cli/package.json", webPackagePath);
	const corePackagePath = resolveModule("playwright-core/package.json", cliPackagePath);
	return join(dirname(corePackagePath), "lib", "entry", "cliDaemon.js");
}

function isDaemonCommand(commandLine: string, daemonEntrypoint: string, sessionName: string): boolean {
	const daemonIndex = commandLine.indexOf(daemonEntrypoint);
	if (daemonIndex <= 0) return false;
	const executable = commandLine.slice(0, daemonIndex).replaceAll('"', "").trim();
	const executableName = executable.split(/[\\/]/u).pop()?.toLowerCase();
	if (!executableName || !new Set(["node", "node.exe", "nodejs"]).has(executableName)) return false;
	const daemonArguments = commandLine
		.slice(daemonIndex + daemonEntrypoint.length)
		.trim()
		.replace(/^"\s*/u, "");
	return daemonArguments === sessionName || daemonArguments.startsWith(`${sessionName} `);
}

function collectAgentLabBrowserProcessTree(
	processes: readonly ProcessRecord[],
	daemonEntrypoint: string,
	sessionName: string,
): AgentLabBrowserProcessTree {
	const rootPids = processes
		.filter(({ commandLine }) => isDaemonCommand(commandLine, daemonEntrypoint, sessionName))
		.map(({ pid }) => pid);
	const processPids = new Set(rootPids);
	let added = true;
	while (added) {
		added = false;
		for (const process of processes) {
			if (processPids.has(process.pid) || !processPids.has(process.ppid)) continue;
			processPids.add(process.pid);
			added = true;
		}
	}
	return {
		rootPids: [...new Set(rootPids)].sort((left, right) => left - right),
		processPids: [...processPids].sort((left, right) => left - right),
	};
}

export function mergeAgentLabBrowserProcessTrees(
	...trees: readonly AgentLabBrowserProcessTree[]
): AgentLabBrowserProcessTree {
	return {
		rootPids: [...new Set(trees.flatMap(({ rootPids }) => rootPids))].sort((left, right) => left - right),
		processPids: [...new Set(trees.flatMap(({ processPids }) => processPids))].sort((left, right) => left - right),
	};
}

export async function findAgentLabBrowserProcessTree(
	repoRoot: string,
	sessionName: string,
	options: FindAgentLabBrowserProcessTreeOptions = {},
): Promise<AgentLabBrowserProcessTree> {
	if (!/^qd-[a-z0-9][a-z0-9-]{0,120}$/iu.test(sessionName)) {
		throw new Error(`Refusing to inspect an invalid Agent Lab browser session: ${JSON.stringify(sessionName)}`);
	}
	const platform = options.platform ?? process.platform;
	const result = await (options.runProcessList ?? (() => defaultRunProcessList(platform)))();
	if (!result.ok) throw new Error("Unable to inspect Agent Lab browser processes.");
	const processes =
		platform === "win32" ? parseWindowsProcessList(result.stdout) : parseUnixProcessList(result.stdout);
	const daemonEntrypoint = (options.resolveDaemonEntrypoint ?? resolvePlaywrightDaemonEntrypoint)(repoRoot);
	return collectAgentLabBrowserProcessTree(processes, daemonEntrypoint, sessionName);
}

function killTree(pid: number, signal: NodeJS.Signals, killProcessTree: KillProcessTree): Promise<void> {
	return new Promise((resolve) => {
		try {
			killProcessTree(pid, signal, () => resolve());
		} catch {
			resolve();
		}
	});
}

export async function terminateAgentLabBrowserProcessTree(
	tree: AgentLabBrowserProcessTree,
	options: TerminateAgentLabBrowserProcessTreeOptions = {},
): Promise<number[]> {
	if (tree.processPids.length === 0) return [];
	const platform = options.platform ?? process.platform;
	const killProcessTree = options.killProcessTree ?? treeKill;
	const isAlive = options.isAlive ?? isProcessAlive;
	const signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
	const waitFor = options.wait ?? wait;

	await Promise.all(tree.rootPids.map((pid) => killTree(pid, "SIGTERM", killProcessTree)));
	if (platform !== "win32") {
		for (const pid of tree.rootPids) {
			try {
				signalProcess(-pid, "SIGTERM");
			} catch {
				// The daemon may have already completed its graceful shutdown.
			}
		}
	}

	const deadline = Date.now() + TERMINATION_GRACE_MS;
	let remaining = tree.processPids.filter(isAlive);
	while (remaining.length > 0 && Date.now() < deadline) {
		await waitFor(TERMINATION_POLL_MS);
		remaining = remaining.filter(isAlive);
	}
	if (remaining.length === 0) return [];

	await Promise.all(tree.rootPids.map((pid) => killTree(pid, "SIGKILL", killProcessTree)));
	for (const pid of [...remaining].reverse()) {
		try {
			signalProcess(pid, "SIGKILL");
		} catch {
			// The process may have exited between the liveness check and signal.
		}
	}
	if (platform !== "win32") {
		for (const pid of tree.rootPids) {
			try {
				signalProcess(-pid, "SIGKILL");
			} catch {
				// The process group may already be empty.
			}
		}
	}
	await waitFor(TERMINATION_POLL_MS);
	return remaining.filter(isAlive);
}

export const _testing = {
	collectAgentLabBrowserProcessTree,
	isDaemonCommand,
	parseUnixProcessList,
	parseWindowsProcessList,
	resolvePlaywrightDaemonEntrypoint,
};
