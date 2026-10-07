import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DesktopLabProcess } from "./desktop-types";

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

export async function listDesktopProcesses(): Promise<DesktopLabProcess[]> {
	const { stdout } = await execFileAsync("/bin/ps", ["-ax", "-o", "pid=,ppid=,stat=,lstart=,command="], {
		encoding: "utf8",
		timeout: 5_000,
	});
	return parseDesktopProcessList(stdout);
}

export function sameDesktopProcess(left: DesktopLabProcess, right: DesktopLabProcess): boolean {
	return left.pid === right.pid && left.startedAt === right.startedAt && left.command === right.command;
}

export function findMarkedDesktopProcesses(
	processes: DesktopLabProcess[],
	appPath: string,
	userDataPath: string,
	hostSimulationConfigPath: string,
): number[] {
	const hasExactMarker = (command: string, marker: string): boolean =>
		command.endsWith(marker) || command.includes(`${marker} `);
	return processes
		.filter(
			(process) =>
				process.command.includes(`${appPath}/Contents/`) &&
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
