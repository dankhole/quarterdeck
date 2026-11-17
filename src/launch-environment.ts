import { execFile } from "node:child_process";
import { release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWindowsPowerShellPath } from "./core/windows-system-paths.js";
import { usesDesktopLaunchDefault } from "./distribution-policy.js";
import { type LaunchEnvironment, supportsDesktopHost } from "./launch-policy.js";

/** A TTY is neither necessary nor sufficient for a local Aqua session. */
export async function readLaunchEnvironment(): Promise<LaunchEnvironment> {
	const environment: LaunchEnvironment = {
		platform: process.platform,
		arch: process.arch,
		osRelease: release(),
		graphicalSession: false,
		desktopHelper: process.env.QUARTERDECK_DESKTOP_CHILD === "1",
		desktopDefault: false,
	};
	if (
		!supportsDesktopHost(environment) ||
		environment.desktopHelper ||
		process.env.SSH_CONNECTION ||
		process.env.SSH_TTY ||
		(process.env.CI && !["0", "false"].includes(process.env.CI.toLowerCase()))
	) {
		return environment;
	}
	environment.graphicalSession = await new Promise<boolean>((resolveSession) => {
		const windows = process.platform === "win32";
		execFile(
			windows ? resolveWindowsPowerShellPath() : "/bin/launchctl",
			windows
				? [
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						"if ([Environment]::UserInteractive -and [Diagnostics.Process]::GetCurrentProcess().SessionId -gt 0) { 'Interactive' }",
					]
				: ["managername"],
			{ timeout: windows ? 5_000 : 2_000, maxBuffer: 1_024, windowsHide: true },
			(error, stdout) => {
				// An unverified graphical session uses the headless runtime path.
				resolveSession(!error && stdout.trim() === (windows ? "Interactive" : "Aqua"));
			},
		);
	});
	if (environment.graphicalSession && process.env.QUARTERDECK_INSTALL_MODE !== "browser") {
		environment.desktopDefault = await usesDesktopLaunchDefault(
			resolve(dirname(fileURLToPath(import.meta.url)), ".."),
		);
	}
	return environment;
}
