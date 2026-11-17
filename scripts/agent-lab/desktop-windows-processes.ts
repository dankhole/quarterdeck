import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveWindowsPowerShellPath } from "../../src/core/windows-system-paths.js";
import type { DesktopLabProcess } from "./desktop-types";

const execute = promisify(execFile);
const rowsSchema = z.array(
	z.object({
		pid: z.number().int().nonnegative(),
		parentPid: z.number().int().nonnegative(),
		birth: z.string(),
		command: z.string(),
	}),
);

export async function listWindowsDesktopProcesses(): Promise<DesktopLabProcess[]> {
	const powershell = resolveWindowsPowerShellPath();
	const module = (name: string) => `'${join(dirname(powershell), "Modules", name).replaceAll("'", "''")}'`;
	const script = [
		"$ErrorActionPreference='Stop'",
		"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
		`Import-Module ${module("CimCmdlets/CimCmdlets.psd1")}`,
		`Import-Module ${module("Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1")}`,
		"$rows=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;birth=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().Ticks.ToString()}else{''});command=[string]$_.CommandLine} })",
		"ConvertTo-Json -InputObject $rows -Compress",
	].join("; ");
	const { stdout } = await execute(
		powershell,
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		{ encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
	);
	return rowsSchema
		.parse(JSON.parse(stdout))
		.filter((row) => row.pid > 0)
		.map((row) => ({
			pid: row.pid,
			parentPid: row.parentPid,
			startedAt: row.birth ? `windows:${row.birth}` : "",
			command: row.command,
		}));
}
