import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DesktopInstallationError } from "./errors.js";
import type { DesktopInstallCommandResult } from "./types.js";

const execute = promisify(execFile);

function operationLabel(command: string, firstArgument: string | undefined): string {
	switch (command) {
		case "/usr/bin/codesign":
			return firstArgument === "--display" ? "signing identity inspection" : "signature verification";
		case "/usr/sbin/spctl":
			return "Gatekeeper assessment";
		case "/usr/bin/plutil":
			return "app metadata inspection";
		case "/usr/bin/lipo":
			return "native architecture inspection";
		case "/usr/bin/ditto":
			return "app copy";
		case "/usr/bin/hdiutil":
			return firstArgument === "attach"
				? "DMG mount"
				: firstArgument === "detach"
					? "DMG unmount"
					: "DMG inspection";
		default:
			return "desktop artifact operation";
	}
}

function failureCategory(error: unknown): string {
	if (typeof error !== "object" || error === null) return "execution failure";
	const code = "code" in error ? error.code : undefined;
	const signal = "signal" in error ? error.signal : undefined;
	const killed = "killed" in error ? error.killed : undefined;
	if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output limit";
	// This wrapper's only kill policy is its timeout, with Node's default SIGTERM.
	if (code === "ETIMEDOUT" || (killed === true && signal === "SIGTERM")) return "timeout";
	if (typeof signal === "string" && signal.length > 0) return "signal termination";
	if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255) return `exit ${code}`;
	if (code === "ENOENT") return "command unavailable";
	if (code === "EACCES" || code === "EPERM") return "permission denied";
	return "execution failure";
}

export async function runDesktopInstallCommand(
	command: string,
	args: readonly string[],
): Promise<DesktopInstallCommandResult> {
	try {
		return await execute(command, [...args], {
			encoding: "utf8",
			timeout: 180_000,
			maxBuffer: 256 * 1024,
			env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
		});
	} catch (error) {
		throw new DesktopInstallationError(
			"command_failed",
			`macOS ${operationLabel(command, args[0])} failed (${failureCategory(error)}). The existing installation was retained.`,
		);
	}
}

export async function verifyDesktopDeveloperSignature(
	appPath: string,
	teamId: string,
	runCommand: (command: string, args: readonly string[]) => Promise<DesktopInstallCommandResult>,
): Promise<void> {
	await runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
	const { stderr } = await runCommand("/usr/bin/codesign", ["--display", "--verbose=4", appPath]);
	if (
		!stderr.split(/\r?\n/u).includes(`TeamIdentifier=${teamId}`) ||
		!/^Authority=Developer ID Application:/mu.test(stderr) ||
		!/^CodeDirectory .*flags=.*\bruntime\b/mu.test(stderr)
	) {
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The app's Developer ID team or hardened runtime does not match the trusted release manifest.",
		);
	}
	await runCommand("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
}
