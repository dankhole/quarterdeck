import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mergeProcessEnvironment } from "../core/process-environment.js";
import { resolveWindowsPowerShellPath } from "../core/windows-system-paths.js";

export interface RuntimeBootIdentityOptions {
	platform?: NodeJS.Platform;
	readLinuxBootId?: () => Promise<string>;
	query?: (binary: string, args: readonly string[]) => Promise<string>;
}

// SystemBootEnvironmentInformation's first field is the kernel BootIdentifier GUID.
// Wall-clock boot timestamps cannot prove a reboot after the system clock changes.
const WINDOWS_BOOT_IDENTITY_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$source = @'",
	"using System;",
	"using System.Runtime.InteropServices;",
	"public static class QuarterdeckBootIdentity {",
	'  [DllImport("ntdll.dll")] private static extern int NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int returned);',
	"  public static string Read() {",
	"    IntPtr buffer = Marshal.AllocHGlobal(64);",
	"    try {",
	"      int returned;",
	"      int status = NtQuerySystemInformation(90, buffer, 64, out returned);",
	'      if (status != 0 || returned < 16 || returned > 64) throw new InvalidOperationException("Boot identity unavailable");',
	"      Guid identity = (Guid)Marshal.PtrToStructure(buffer, typeof(Guid));",
	'      if (identity == Guid.Empty) throw new InvalidOperationException("Empty boot identity");',
	'      return identity.ToString("D");',
	"    } finally { Marshal.FreeHGlobal(buffer); }",
	"  }",
	"}",
	"'@",
	"Add-Type -TypeDefinition $source",
	"[QuarterdeckBootIdentity]::Read()",
].join("\n");

function readUuid(value: string): string | null {
	const normalized = value.trim().toLowerCase();
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(normalized) &&
		normalized !== "00000000-0000-0000-0000-000000000000"
		? normalized
		: null;
}

function queryBootIdentity(binary: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			binary,
			[...args],
			{
				encoding: "utf8",
				timeout: process.platform === "win32" ? 5_000 : 1_500,
				maxBuffer: 4_096,
				windowsHide: true,
				env: mergeProcessEnvironment(process.env, { LC_ALL: "C" }),
			},
			(error, stdout) => {
				if (error) reject(new Error("System boot identity query unavailable."));
				else resolve(stdout.trim());
			},
		);
	});
}

/** Boot-session evidence; null is unknown and never proves old descendants have exited. */
export async function readRuntimeBootIdentity(options: RuntimeBootIdentityOptions = {}): Promise<string | null> {
	const platform = options.platform ?? process.platform;
	const query = options.query ?? queryBootIdentity;
	try {
		if (platform === "linux" || platform === "darwin") {
			const identity = (
				platform === "linux"
					? await (options.readLinuxBootId ?? (() => readFile("/proc/sys/kernel/random/boot_id", "utf8")))()
					: await query("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])
			).trim();
			const uuid = readUuid(identity);
			return uuid ? `${platform}:${uuid}` : null;
		}
		if (platform === "win32") {
			const identity = (
				await query(resolveWindowsPowerShellPath(), [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-EncodedCommand",
					Buffer.from(WINDOWS_BOOT_IDENTITY_SCRIPT, "utf16le").toString("base64"),
				])
			).trim();
			const uuid = readUuid(identity);
			return uuid ? `windows:${uuid}` : null;
		}
		return null;
	} catch {
		return null;
	}
}
