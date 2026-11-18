import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DesktopLabProcess } from "./desktop-types";
import { listWindowsDesktopProcesses } from "./desktop-windows-processes";

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

const execFileAsync = promisify(execFile);

export function parseDesktopProcessList(contents: string): DesktopLabProcess[] {
	return contents.split("\n").flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.+)$/u);
		if (!match || match[3]?.startsWith("Z")) return [];
		return [
			{
				pid: Number(match[1]),
				parentPid: Number(match[2]),
				startedAt: match[4]?.trim() ?? "",
				command: match[5]?.trim() ?? "",
			},
		];
	});
}

export async function listDesktopProcesses(platform: NodeJS.Platform = process.platform): Promise<DesktopLabProcess[]> {
	if (platform === "win32") return listWindowsDesktopProcesses();
	const { stdout } = await execFileAsync("/bin/ps", ["-ax", "-o", "pid=,ppid=,stat=,lstart=,command="], {
		encoding: "utf8",
		env: processListEnvironment(process.env),
		timeout: 5_000,
		// A busy machine under heavy load runs far more processes than Node's
		// 1MB execFile default tolerates, which previously surfaced as a
		// confusing "stdout maxBuffer length exceeded" failure unrelated to
		// this helper's actual correctness.
		maxBuffer: 10 * 1024 * 1024,
	});
	return parseDesktopProcessList(stdout);
}

export function sameDesktopProcess(left: DesktopLabProcess, right: DesktopLabProcess): boolean {
	if (left.pid !== right.pid || left.startedAt !== right.startedAt) return false;
	// Windows may stop exposing argv while an owned process is exiting. Its
	// precise kernel creation identity still fences PID reuse; compare argv too
	// whenever both observations can read it. Unix birth timestamps are coarser.
	return (
		left.command === right.command || (left.startedAt.startsWith("windows:") && (!left.command || !right.command))
	);
}

export function findMarkedDesktopProcesses(
	processes: DesktopLabProcess[],
	appPath: string,
	userDataPath: string,
	hostSimulationConfigPath: string,
): number[] {
	const hasExactMarker = (command: string, marker: string): boolean =>
		command.endsWith(marker) ||
		command.includes(`${marker} `) ||
		command.endsWith(`${marker}"`) ||
		command.includes(`${marker}" `);
	return processes
		.filter(
			(process) =>
				(process.command.includes(`${appPath}/Contents/`) || process.command.includes(`${appPath}\\`)) &&
				(hasExactMarker(process.command, `--user-data-dir=${userDataPath}`) ||
					hasExactMarker(process.command, hostSimulationConfigPath)),
		)
		.map((process) => process.pid);
}

/** Follow exact descendants and retained identities, never executable-name matches. */
export function collectOwnedDesktopProcesses(
	processes: DesktopLabProcess[],
	rootPids: number[],
	previous: DesktopLabProcess[] = [],
): DesktopLabProcess[] {
	const retained = new Map(previous.map((process) => [process.pid, process]));
	const indexed = new Map(processes.map((entry) => [entry.pid, entry]));
	for (const earlier of previous) {
		const current = indexed.get(earlier.pid);
		if (current && !current.startedAt)
			throw new Error("An owned desktop process has unreadable identity; cleanup remains unconfirmed.");
	}
	const owned = new Set(
		processes
			.filter((process) => {
				const earlier = retained.get(process.pid);
				return earlier ? sameDesktopProcess(process, earlier) : rootPids.includes(process.pid);
			})
			.map((process) => process.pid),
	);
	let added = true;
	while (added) {
		added = false;
		for (const process of processes) {
			if (!owned.has(process.pid) && owned.has(process.parentPid)) {
				const parent = indexed.get(process.parentPid);
				if (parent?.startedAt.startsWith("windows:")) {
					if (!process.startedAt) throw new Error("A desktop descendant has unreadable Windows identity.");
					if (
						!process.startedAt.startsWith("windows:") ||
						BigInt(process.startedAt.slice(8)) < BigInt(parent.startedAt.slice(8))
					)
						continue;
				}
				owned.add(process.pid);
				added = true;
			}
		}
	}
	return processes.filter((process) => owned.has(process.pid));
}

export interface DesktopCleanupDependencies {
	list: () => Promise<DesktopLabProcess[]>;
	signal: (pid: number, signal: NodeJS.Signals) => void;
	wait: (milliseconds: number) => Promise<void>;
}

/** All fallback signals recheck both start time and argv to fence PID reuse. */
export async function stopOwnedDesktopProcesses(
	known: DesktopLabProcess[],
	dependencies: DesktopCleanupDependencies = {
		list: listDesktopProcesses,
		signal: (pid, signal) => {
			process.kill(pid, signal);
		},
		wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
	},
): Promise<number[]> {
	let owned = known;
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		const current = collectOwnedDesktopProcesses(await dependencies.list(), [], owned);
		owned = [...new Map([...owned, ...current].map((process) => [process.pid, process])).values()];
		for (const process of [...current].reverse()) {
			try {
				dependencies.signal(process.pid, signal);
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"))
					throw error;
			}
		}
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const remaining = collectOwnedDesktopProcesses(await dependencies.list(), [], owned);
			if (remaining.length === 0) return [];
			owned = [...new Map([...owned, ...remaining].map((process) => [process.pid, process])).values()];
			await dependencies.wait(100);
		}
	}
	return collectOwnedDesktopProcesses(await dependencies.list(), [], owned).map((process) => process.pid);
}
