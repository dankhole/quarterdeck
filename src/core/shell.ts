import { win32 } from "node:path";

import { buildWindowsProcessArgsCommandLine, resolveWindowsComSpec } from "./windows-cmd-launch.js";
import { resolveWindowsPowerShellPath } from "./windows-system-paths.js";

export {
	resolveWindowsPowerShellPath,
	resolveWindowsRootExecutablePath,
	resolveWindowsSystem32ExecutablePath,
} from "./windows-system-paths.js";

export function resolveInteractiveShellCommand(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): { binary: string; args: string[] } {
	if (platform === "win32") {
		return {
			binary: resolveWindowsComSpec(env),
			args: [],
		};
	}

	const command = env.SHELL?.trim();
	if (command) {
		return {
			binary: command,
			args: ["-i"],
		};
	}
	return {
		binary: "bash",
		args: ["-i"],
	};
}

function quotePosixShellArg(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function quotePowerShellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function quoteWindowsCommandExecutable(value: string): string {
	if (!win32.isAbsolute(value) || /["\r\n]/u.test(value)) {
		throw new Error("Windows command executable must be an absolute path without quotes or newlines.");
	}
	return `"${value}"`;
}

function buildWindowsShellCommandLine(binary: string, args: string[], env: NodeJS.ProcessEnv): string {
	// Provider hook/status-line APIs accept only a shell string. Keep all
	// invocation data out of cmd.exe's expansion passes by encoding a PowerShell
	// bootstrap, then start the target through ProcessStartInfo with inherited
	// stdio so status-line input/output stays byte-oriented.
	const launch = JSON.stringify({
		fileName: binary,
		arguments: buildWindowsProcessArgsCommandLine(args),
	});
	const script = [
		`$launch = ConvertFrom-Json -InputObject ${quotePowerShellLiteral(launch)}`,
		"$startInfo = New-Object System.Diagnostics.ProcessStartInfo",
		"$startInfo.UseShellExecute = $false",
		"$startInfo.FileName = [string]$launch.fileName",
		"$startInfo.Arguments = [string]$launch.arguments",
		"$child = [System.Diagnostics.Process]::Start($startInfo)",
		"$child.WaitForExit()",
		"exit $child.ExitCode",
	].join("; ");
	const encodedScript = Buffer.from(script, "utf16le").toString("base64");
	const powerShellPath = quoteWindowsCommandExecutable(resolveWindowsPowerShellPath(env));
	return `"${powerShellPath} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedScript}"`;
}

export function buildShellCommandLine(
	binary: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform === "win32") {
		return buildWindowsShellCommandLine(binary, args, env);
	}
	return [binary, ...args].map((part) => quotePosixShellArg(part)).join(" ");
}
