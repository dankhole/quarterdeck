import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DesktopInstallationError } from "./errors.js";

const execute = promisify(execFile);
/** Native helper derives the fixed per-user shortcut and target; no shell commands or client paths. */
export async function updateWindowsDesktopShortcut(bootstrap: string, operation: "install" | "remove"): Promise<void> {
	try {
		await execute(bootstrap, [`--quarterdeck-shortcut-${operation}`], {
			timeout: 15000,
			windowsHide: true,
			maxBuffer: 4096,
		});
	} catch {
		throw new DesktopInstallationError(
			"command_failed",
			"The Windows Start menu shortcut could not be updated. Check directory permissions or move an unrelated Quarterdeck shortcut aside, then repeat desktop install or uninstall.",
		);
	}
}
