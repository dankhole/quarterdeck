import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { resolveWindowsPowerShellPath } from "../../src/core";

import {
	type AgentLabBrowserProcessIdentity,
	type AgentLabBrowserProcessTree,
	assertBrowserOwnershipUnambiguous,
	browserOwnedGroups,
	browserProcessIdentity,
	inspectBrowserOwnership,
	type AgentLabBrowserProcessRecord as ProcessRecord,
} from "./browser-process-ownership";

export type { AgentLabBrowserProcessIdentity, AgentLabBrowserProcessTree } from "./browser-process-ownership";

const PROCESS_LIST_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 3_000;
const TERMINATION_POLL_MS = 100;
const ESCALATION_MAX_PASSES = 5;

interface ProcessListResult {
	ok: boolean;
	stdout: string;
}

interface FindAgentLabBrowserProcessTreeOptions {
	platform?: NodeJS.Platform;
	resolveDaemonEntrypoint?: (repoRoot: string) => string;
	runProcessList?: () => Promise<ProcessListResult>;
	isExecutable?: (path: string) => boolean;
	groups?: readonly AgentLabBrowserProcessIdentity[];
}

interface TerminateAgentLabBrowserProcessTreeOptions {
	platform?: NodeJS.Platform;
	runProcessList?: () => Promise<ProcessListResult>;
	signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
	wait?: (milliseconds: number) => Promise<void>;
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function processListEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const { LC_ALL, ...environment } = source;
	return {
		...environment,
		// LC_ALL overrides LC_TIME. Preserve its effective character locale when
		// removing it, rather than forcing ASCII command rendering on macOS.
		...(LC_ALL ? { LC_CTYPE: LC_ALL } : {}),
		LC_TIME: "C",
		TZ: "UTC",
	};
}

function runExecFile(command: string, args: string[]): Promise<ProcessListResult> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				encoding: "utf8",
				timeout: PROCESS_LIST_TIMEOUT_MS,
				maxBuffer: 4 * 1024 * 1024,
				windowsHide: true,
				env: processListEnvironment(process.env),
			},
			(error: ExecFileException | null, stdout: string | Buffer) => {
				resolve({ ok: !error, stdout: String(stdout ?? "") });
			},
		);
	});
}

function buildWindowsProcessListScript(): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		"$rows = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; startTime = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); commandLine = [string]$_.CommandLine } })",
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
		return await runExecFile(resolveWindowsPowerShellPath(), args);
	}
	return await runExecFile("ps", ["-ax", "-o", "pid=,ppid=,pgid=,lstart=,command="]);
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
		throw new Error("Unable to parse Agent Lab browser process snapshot.");
	}
	const records = Array.isArray(parsed) ? parsed : [parsed];
	const processes: ProcessRecord[] = [];
	for (const value of records) {
		if (typeof value !== "object" || value === null) throw new Error("Ambiguous browser process snapshot row.");
		const record = value as Record<string, unknown>;
		const pid = readNumberField(record, "pid");
		const ppid = readNumberField(record, "ppid");
		const commandLine = typeof record.commandLine === "string" ? record.commandLine.trim() : "";
		if (pid === null || ppid === null) throw new Error("Ambiguous browser process snapshot row.");
		if (pid === 0) continue; // Windows includes the unsignalable System Idle Process.
		const startTime = typeof record.startTime === "string" && record.startTime.trim() ? record.startTime : null;
		processes.push({ pid, ppid, startTime, commandLine });
	}
	return processes;
}

function parseUnixProcessList(stdout: string): ProcessRecord[] {
	const processes: ProcessRecord[] = [];
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
		if (!line.trim()) continue;
		if (!match) throw new Error("Ambiguous browser process snapshot row.");
		const pid = Number(match[1]);
		const ppid = Number(match[2]);
		const fields = match[3]?.trim() ?? "";
		const grouped = fields.match(/^(\d+)\s+(.+)$/u);
		const identity = (grouped?.[2] ?? fields).match(/^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u);
		const startTime = identity?.[1]?.replace(/\s+/gu, " ") ?? null;
		const commandLine = identity?.[2] ?? fields;
		processes.push({ pid, ppid, ...(grouped ? { pgid: Number(grouped[1]) } : {}), startTime, commandLine });
	}
	return processes;
}

async function inspectProcesses(
	platform: NodeJS.Platform,
	runProcessList: () => Promise<ProcessListResult>,
): Promise<ProcessRecord[]> {
	const result = await runProcessList();
	if (!result.ok) throw new Error("Unable to inspect Agent Lab browser processes.");
	const processes =
		platform === "win32" ? parseWindowsProcessList(result.stdout) : parseUnixProcessList(result.stdout);
	const pids = new Set<number>();
	for (const row of processes) {
		if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || pids.has(row.pid)) {
			throw new Error("Ambiguous browser process snapshot PID.");
		}
		pids.add(row.pid);
	}
	return processes;
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function resolveModuleFrom(specifier: string, parentPath: string): string {
	return createRequire(parentPath).resolve(specifier);
}

function resolvePlaywrightDaemonEntrypoint(
	repoRoot: string,
	resolveModule: (specifier: string, parentPath: string) => string = resolveModuleFrom,
): string {
	const webPackagePath = join(repoRoot, "web-ui", "package.json");
	try {
		const cliPackagePath = resolveModule("@playwright/cli/package.json", webPackagePath);
		const corePackagePath = resolveModule("playwright-core/package.json", cliPackagePath);
		return join(dirname(corePackagePath), "lib", "entry", "cliDaemon.js");
	} catch {
		// An abandoned run can outlive its worktree's installed dependencies. Keep
		// the worktree-local entrypoint boundary even when npm can no longer resolve it.
		return join(repoRoot, "web-ui", "node_modules", "playwright-core", "lib", "entry", "cliDaemon.js");
	}
}

function isDaemonCommand(
	commandLine: string,
	daemonEntrypoint: string,
	sessionName: string,
	platform: NodeJS.Platform = process.platform,
	isExecutable: (path: string) => boolean = isExecutableFile,
): boolean {
	const comparisonCommandLine = platform === "win32" ? commandLine.toLowerCase() : commandLine;
	const comparisonEntrypoint = platform === "win32" ? daemonEntrypoint.toLowerCase() : daemonEntrypoint;
	const daemonIndex = comparisonCommandLine.indexOf(comparisonEntrypoint);
	if (daemonIndex <= 0) return false;
	// Match the executable itself, not a path quoted by echo, a shell, or an
	// agent transcript before the daemon entrypoint. Ambiguous rows fail closed.
	const executableMatch = commandLine.slice(0, daemonIndex).match(/^(?:"([^"]+)"|([^\s"]+))\s+"?$/u);
	let executable = executableMatch?.[1] ?? executableMatch?.[2];
	if (!executable && platform !== "win32") {
		// Unix ps does not quote executable paths with spaces. Only accept the
		// entire prefix as a path when it really is an executable file, not echo
		// arguments or a transcript that happens to end in a Node basename.
		const prefix = commandLine.slice(0, daemonIndex).trim();
		if (isExecutable(prefix)) executable = prefix;
	}
	const executableName = executable?.split(/[\\/]/u).pop()?.toLowerCase();
	if (!executableName || !new Set(["node", "node.exe", "nodejs", "nodehost"]).has(executableName)) return false;
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
	platform: NodeJS.Platform,
	isExecutable?: (path: string) => boolean,
	retainedGroups: readonly AgentLabBrowserProcessIdentity[] = [],
): AgentLabBrowserProcessTree {
	const rootPids = processes
		.filter(({ commandLine }) => isDaemonCommand(commandLine, daemonEntrypoint, sessionName, platform, isExecutable))
		.map(({ pid }) => pid);
	const owned = new Map(
		processes.filter(({ pid }) => rootPids.includes(pid)).map((row) => [row.pid, browserProcessIdentity(row)]),
	);
	const ambiguous = new Set<number>();
	const groups = browserOwnedGroups(
		{ rootPids, processPids: rootPids, identities: [...owned.values()], groups: [...retainedGroups] },
		platform,
		ambiguous,
	);
	const processPids = inspectBrowserOwnership(processes, owned, groups, ambiguous);
	assertBrowserOwnershipUnambiguous(ambiguous);
	return {
		rootPids: [...new Set(rootPids)].sort((left, right) => left - right),
		processPids: processPids.sort((left, right) => left - right),
		identities: processPids
			.map((pid) => owned.get(pid))
			.filter((identity): identity is AgentLabBrowserProcessIdentity => identity !== undefined),
		...(groups.size > 0 ? { groups: [...groups.values()] } : {}),
	};
}

function deduplicateIdentities(
	identities: readonly AgentLabBrowserProcessIdentity[],
): AgentLabBrowserProcessIdentity[] {
	return [
		...new Map(
			identities.map((identity) => [
				JSON.stringify([identity.pid, identity.startTime, identity.commandLine, identity.pgid]),
				identity,
			]),
		).values(),
	];
}

export function mergeAgentLabBrowserProcessTrees(
	...trees: readonly AgentLabBrowserProcessTree[]
): AgentLabBrowserProcessTree {
	const groups = trees.flatMap(({ groups }) => groups ?? []);
	return {
		...(groups.length > 0 ? { groups: deduplicateIdentities(groups) } : {}),
		rootPids: [...new Set(trees.flatMap(({ rootPids }) => rootPids))].sort((left, right) => left - right),
		processPids: [...new Set(trees.flatMap(({ processPids }) => processPids))].sort((left, right) => left - right),
		// Keep conflicting identities rather than silently adopting a reused PID.
		identities: deduplicateIdentities(trees.flatMap(({ identities }) => identities ?? [])),
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
	const processes = await inspectProcesses(
		platform,
		options.runProcessList ?? (() => defaultRunProcessList(platform)),
	);
	const daemonEntrypoint = (options.resolveDaemonEntrypoint ?? resolvePlaywrightDaemonEntrypoint)(repoRoot);
	return collectAgentLabBrowserProcessTree(
		processes,
		daemonEntrypoint,
		sessionName,
		platform,
		options.isExecutable,
		options.groups,
	);
}

/**
 * Unix orphan discovery requires a previously verified owned process-group leader.
 * Windows has no Job Object here: unseen helpers orphaned between snapshots cannot
 * be safely attributed. Captured Windows descendants still retain exact identities.
 */
export async function terminateAgentLabBrowserProcessTree(
	tree: AgentLabBrowserProcessTree,
	options: TerminateAgentLabBrowserProcessTreeOptions = {},
): Promise<number[]> {
	if (tree.processPids.length === 0 && !tree.groups?.length) return [];
	const platform = options.platform ?? process.platform;
	const runProcessList = options.runProcessList ?? (() => defaultRunProcessList(platform));
	const signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
	const waitFor = options.wait ?? wait;
	const owned = new Map<number, AgentLabBrowserProcessIdentity>();
	const ambiguous = new Set<number>();
	for (const pid of tree.processPids) {
		const identities = tree.identities?.filter((identity) => identity.pid === pid) ?? [];
		const identity = identities[0];
		if (!identity || identities.length !== 1 || !identity.startTime) ambiguous.add(pid);
		else owned.set(pid, identity);
	}

	const groups = browserOwnedGroups(tree, platform, ambiguous);
	const inspectOwned = async (): Promise<number[]> =>
		inspectBrowserOwnership(await inspectProcesses(platform, runProcessList), owned, groups, ambiguous);
	const signalMatching = async (pid: number, signal: NodeJS.Signals): Promise<void> => {
		// Reinspect immediately before each signal, including escalation. Never
		// tree-kill or signal a group: either could include a reused root/group or
		// an unverified descendant that was not in our ownership snapshot.
		if (!(await inspectOwned()).includes(pid)) return;
		try {
			signalProcess(pid, signal);
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) throw error;
		}
	};

	for (const pid of await inspectOwned()) await signalMatching(pid, "SIGTERM");
	const deadline = Date.now() + TERMINATION_GRACE_MS;
	let remaining = await inspectOwned();
	while (remaining.length > 0 && Date.now() < deadline) {
		await waitFor(TERMINATION_POLL_MS);
		remaining = await inspectOwned();
	}
	// A last-moment child may become visible only after its parent exits. Keep
	// the verified group boundary through bounded, individually checked passes.
	for (let pass = 0; pass < ESCALATION_MAX_PASSES && remaining.length > 0; pass += 1) {
		for (const pid of [...remaining].reverse()) await signalMatching(pid, "SIGKILL");
		await waitFor(TERMINATION_POLL_MS);
		remaining = await inspectOwned();
	}
	remaining = await inspectOwned();
	assertBrowserOwnershipUnambiguous(ambiguous);
	if (remaining.some((pid) => !tree.processPids.includes(pid))) {
		throw new Error(`Agent Lab browser cleanup left newly observed descendants running: ${remaining.join(", ")}`);
	}
	return remaining;
}

export const _testing = {
	collectAgentLabBrowserProcessTree,
	isDaemonCommand,
	parseUnixProcessList,
	parseWindowsProcessList,
	resolvePlaywrightDaemonEntrypoint,
	processListEnvironment,
};
