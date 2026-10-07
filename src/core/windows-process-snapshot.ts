import { type ExecFileException, execFile } from "node:child_process";

import { mergeProcessEnvironment } from "./process-environment.js";
import { terminateProcessForTimeout } from "./process-termination.js";
import { resolveWindowsPowerShellPath } from "./windows-system-paths.js";

const PROCESS_IDENTITY_ENVIRONMENT_KEY = "QUARTERDECK_PROCESS_IDENTITY_PIDS";
const PROCESS_SNAPSHOT_ALL_ENVIRONMENT_KEY = "QUARTERDECK_PROCESS_SNAPSHOT_ALL";
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 10_000;

export const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$serializedPids = [Environment]::GetEnvironmentVariable('QUARTERDECK_PROCESS_IDENTITY_PIDS', 'Process')",
	"$requestedPids = if ([string]::IsNullOrWhiteSpace($serializedPids)) { @() } else { @(ConvertFrom-Json -InputObject $serializedPids) }",
	"$requested = @{}",
	"foreach ($requestedPid in $requestedPids) { $requested[[int]$requestedPid] = $true }",
	"$allProcesses = [Environment]::GetEnvironmentVariable('QUARTERDECK_PROCESS_SNAPSHOT_ALL', 'Process') -eq '1'",
	"$processes = if ($allProcesses) { @(Get-CimInstance Win32_Process) } elseif ($requested.Count -eq 0) { @() } else { $filter = (($requested.Keys | ForEach-Object { 'ProcessId = ' + [int]$_ }) -join ' OR '); @(Get-CimInstance Win32_Process -Filter $filter) }",
	"$rows = @(foreach ($process in $processes) { if ($process.ProcessId -eq 0) { continue }; if ($null -eq $process.CreationDate) { if ($allProcesses) { [pscustomobject]@{ pid = [int]$process.ProcessId; parentPid = [int]$process.ParentProcessId; creationTime = $null } }; continue }; [pscustomobject]@{ pid = [int]$process.ProcessId; parentPid = [int]$process.ParentProcessId; creationTime = ([datetime]$process.CreationDate).ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture) } })",
	"ConvertTo-Json -InputObject $rows -Compress",
].join("; ");

const WINDOWS_PROCESS_SNAPSHOT_ENCODED_SCRIPT = Buffer.from(WINDOWS_PROCESS_SNAPSHOT_SCRIPT, "utf16le").toString(
	"base64",
);

export interface WindowsProcessSnapshotResult {
	ok: boolean;
	stdout: string;
}

export type WindowsProcessSnapshotRunner = (pids?: readonly number[]) => Promise<WindowsProcessSnapshotResult>;

export interface WindowsProcessTreeSnapshot {
	pid: number;
	parentPid: number;
	creationTime: string | null;
}

/** Query metadata only, using a fixed system executable and noninteractive script. */
export function runWindowsProcessSnapshot(
	pids: readonly number[] = [],
	allProcesses = false,
	timeoutMs = WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
): Promise<WindowsProcessSnapshotResult> {
	return new Promise((resolve) => {
		let timeout: NodeJS.Timeout | null = null;
		const child = execFile(
			resolveWindowsPowerShellPath(),
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-EncodedCommand",
				WINDOWS_PROCESS_SNAPSHOT_ENCODED_SCRIPT,
			],
			{
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
				env: mergeProcessEnvironment(process.env, {
					[PROCESS_IDENTITY_ENVIRONMENT_KEY]: JSON.stringify(pids),
					[PROCESS_SNAPSHOT_ALL_ENVIRONMENT_KEY]: allProcesses ? "1" : "0",
				}),
				windowsHide: true,
			},
			(error: ExecFileException | null, stdout: string | Buffer) => {
				if (timeout) clearTimeout(timeout);
				resolve({ ok: error === null, stdout: String(stdout ?? "") });
			},
		);
		timeout = setTimeout(() => terminateProcessForTimeout(child), timeoutMs);
		timeout.unref();
	});
}

/** No ownership registry, application state, or executable-name matching is needed for this read. */
export async function queryWindowsProcessTreeSnapshot(
	runSnapshot: typeof runWindowsProcessSnapshot = runWindowsProcessSnapshot,
): Promise<WindowsProcessTreeSnapshot[]> {
	const result = await runSnapshot([], true, 1_500);
	if (!result.ok) throw new Error("Could not query Windows process trees.");
	const parsed: unknown = JSON.parse(result.stdout);
	const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
	return rows.map((row) => {
		if (
			typeof row !== "object" ||
			row === null ||
			!("pid" in row) ||
			typeof row.pid !== "number" ||
			!Number.isSafeInteger(row.pid) ||
			row.pid <= 0 ||
			!("parentPid" in row) ||
			typeof row.parentPid !== "number" ||
			!Number.isInteger(row.parentPid) ||
			row.parentPid < 0
		) {
			throw new Error("Windows returned an incomplete process tree.");
		}
		const creationTime =
			"creationTime" in row && typeof row.creationTime === "string" && /^\d+$/u.test(row.creationTime)
				? row.creationTime
				: null;
		return { pid: row.pid, parentPid: row.parentPid, creationTime };
	});
}
