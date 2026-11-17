import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isNodeError } from "../fs/node-error.js";
import { DesktopInstallationError } from "./errors.js";

/** Reject redirection before creating protected storage or applying directory permissions. */
export async function validateDesktopDirectoryAncestors(path: string): Promise<void> {
	let candidate = resolve(path);
	for (;;) {
		try {
			const info = await lstat(candidate);
			if (
				(info.isSymbolicLink() && (process.platform === "win32" || info.uid !== 0)) ||
				(!info.isDirectory() && !info.isSymbolicLink())
			)
				throw new DesktopInstallationError(
					"installation_changed",
					"An installation path ancestor is a user-controlled symbolic link or non-directory. No installation files were changed.",
				);
		} catch (error) {
			if (!isNodeError(error, "ENOENT")) throw error;
		}
		if (dirname(candidate) === candidate) return;
		candidate = dirname(candidate);
	}
}
