import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { resolveWindowsPowerShellPath } from "../../src/core/windows-system-paths.js";
import type { DesktopLabProcess } from "./desktop-types";

const execute = promisify(execFile);
const SNAPSHOT_TIMEOUT_MS = 10_000;

const SNAPSHOT_SCRIPT = [
	"$ErrorActionPreference='Stop'",
	"try {",
	"[Console]::Error.WriteLine('qd-stage=load-cim')",
	"Import-Module ([IO.Path]::Combine($PSHOME,'Modules','CimCmdlets','CimCmdlets.psd1'))",
	"[Console]::Error.WriteLine('qd-stage=query')",
	"$rows = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate, CommandLine FROM Win32_Process')",
	"[Console]::Error.WriteLine('qd-stage=output')",
	"$culture = [Globalization.CultureInfo]::InvariantCulture",
	// A small ASCII wire format avoids loading PowerShell.Utility just to serialize the rows.
	// Base64 keeps Unicode argv and embedded tab/newline characters within one record.
	"foreach ($row in $rows) {",
	"  $birth = if ($null -ne $row.CreationDate) { $row.CreationDate.ToUniversalTime().Ticks.ToString($culture) } else { '' }",
	"  $command = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$row.CommandLine))",
	'  [Console]::WriteLine(("{0}`t{1}`t{2}`t{3}" -f $row.ProcessId, $row.ParentProcessId, $birth, $command))',
	"}",
	'[Console]::WriteLine(("done`t{0}" -f $PID))',
	"} catch {",
	"  $failure = $_.Exception",
	"  [Console]::Error.WriteLine(('qd-hresult={0:X8}' -f $failure.HResult))",
	"  if ($failure.GetType().FullName -eq 'Microsoft.Management.Infrastructure.CimException') {",
	"    [Console]::Error.WriteLine(('qd-cim-status={0}' -f [int]$failure.NativeErrorCode))",
	"  }",
	"  exit 1",
	"}",
].join("\n");
const ENCODED_SNAPSHOT = Buffer.from(SNAPSHOT_SCRIPT, "utf16le").toString("base64");

function parseSnapshot(stdout: string): DesktopLabProcess[] {
	const lines = stdout.trimEnd().split(/\r?\n/u);
	const probePid = Number(/^done\t([1-9]\d*)$/u.exec(lines.pop() ?? "")?.[1]);
	const processes = new Map<number, DesktopLabProcess>();
	for (const line of lines) {
		const fields = /^(\d+)\t(\d+)\t(\d*)\t([A-Za-z0-9+/]*={0,2})$/u.exec(line);
		if (!fields) throw new Error("Windows process snapshot returned a malformed row.");
		const [, rawPid, rawParentPid, birth, encoded] = fields;
		const pid = Number(rawPid);
		const parentPid = Number(rawParentPid);
		const command = Buffer.from(encoded, "base64");
		if (pid > 0xffffffff || parentPid > 0xffffffff || processes.has(pid) || command.toString("base64") !== encoded)
			throw new Error("Windows process snapshot returned an invalid row.");
		if (pid > 0) {
			processes.set(pid, {
				pid,
				parentPid,
				startedAt: birth ? `windows:${birth}` : "",
				command: command.toString("utf8"),
			});
		}
	}
	const probe = processes.get(probePid);
	if (!probe?.startedAt || !probe.command) {
		throw new Error("Windows process snapshot did not confirm its own probe process and creation identity.");
	}
	return [...processes.values()];
}

function snapshotFailure(error: unknown, startedAt: number): Error {
	const failure = error as { code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown };
	const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
	const stage = /^qd-stage=(output|query|load-cim)\r?$/gmu;
	const lastStage = [...stderr.matchAll(stage)].at(-1)?.[1] ?? "startup";
	const hresult = /^qd-hresult=([A-F0-9]{8})\r?$/mu.exec(stderr)?.[1];
	const cimStatus = /^qd-cim-status=(\d{1,10})\r?$/mu.exec(stderr)?.[1];
	const { code, signal } = failure;
	const status =
		typeof code === "number" || (typeof code === "string" && /^[A-Z0-9_]{1,48}$/u.test(code)) ? `, code=${code}` : "";
	const ended = typeof signal === "string" && /^SIG[A-Z]+$/u.test(signal) ? `, signal=${signal}` : "";
	const elapsed = Math.round(performance.now() - startedAt);
	const deadline =
		failure.killed === true && code == null && elapsed >= SNAPSHOT_TIMEOUT_MS ? ", deadline exceeded" : "";
	// Never attach the raw child error: its argv or stdout can contain process command lines.
	return new Error(
		`Windows process snapshot failed (stage=${lastStage}, elapsed=${elapsed}ms${status}${ended}${deadline}${hresult ? `, HRESULT=0x${hresult}` : ""}${cimStatus ? `, CIM status=${cimStatus}` : ""}).`,
	);
}

export async function listWindowsDesktopProcesses(): Promise<DesktopLabProcess[]> {
	const powershell = resolveWindowsPowerShellPath();
	const startedAt = performance.now();
	const { stdout } = await execute(
		powershell,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SNAPSHOT],
		{ encoding: "utf8", windowsHide: true, timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
	).catch((error: unknown) => {
		throw snapshotFailure(error, startedAt);
	});
	return parseSnapshot(stdout);
}
