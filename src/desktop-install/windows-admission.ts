import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ensurePrivateDirectory } from "../core/private-directory.js";
import { DesktopInstallationError } from "./errors.js";
import { desktopFileSha256 } from "./files.js";
import { validateDesktopDirectoryAncestors } from "./path-safety.js";

const execute = promisify(execFile);
const leaseSchema = z.strictObject({
	handle: z.string().regex(/^[a-f0-9]{1,16}$/u),
	birth: z.string().regex(/^[a-f0-9]{1,16}$/u),
});

/** The duplicated kernel handle belongs to this Node process, never to a lock-server lifetime. */
export async function acquireWindowsDesktopMutation(bootstrap: string, lockPath: string): Promise<() => Promise<void>> {
	const metadata = dirname(lockPath);
	await validateDesktopDirectoryAncestors(metadata);
	await ensurePrivateDirectory(metadata);
	if ((await readdir(metadata)).filter((name) => /^\.mutation-[a-f0-9-]{36}$/u.test(name)).length >= 4)
		throw new DesktopInstallationError(
			"incomplete_installation",
			"Four retained Windows admission helpers require inspection before another installation attempt.",
		);
	const directory = join(metadata, `.mutation-${randomUUID()}`);
	await mkdir(directory);
	await ensurePrivateDirectory(directory);
	const retained = join(directory, "admission.exe");
	let lease: z.infer<typeof leaseSchema>;
	let acquisitionStarted = false;
	try {
		const source = await lstat(bootstrap);
		if (!source.isFile() || source.isSymbolicLink()) throw new Error("Invalid native admission helper.");
		const expected = await desktopFileSha256(bootstrap);
		await copyFile(bootstrap, retained);
		if ((await desktopFileSha256(retained)) !== expected)
			throw new Error("Native admission helper changed during copy.");
		acquisitionStarted = true;
		const { stdout } = await execute(win32.toNamespacedPath(retained), ["--quarterdeck-acquire-mutation", lockPath], {
			windowsHide: true,
			timeout: 15000,
			maxBuffer: 4096,
		});
		lease = leaseSchema.parse(JSON.parse(stdout));
	} catch (error) {
		// A crash after duplication intentionally retains admission until Node exits.
		// Preserve the copied helper for an ambiguous acquisition, rather than guessing a handle.
		const nativeCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		const refused = nativeCode === 73 || nativeCode === 74;
		if (!acquisitionStarted || refused) await rm(directory, { recursive: true, force: true });
		throw new DesktopInstallationError(
			"installation_in_use",
			nativeCode === 74
				? "Windows could not confirm that a prior native launch drained all descendants. Restart Windows before installing, updating, or uninstalling Quarterdeck; do not delete its launch markers."
				: "Quarterdeck is in use or Windows installation admission could not be verified. Quit Quarterdeck and retry.",
		);
	}
	const acquired = lease;
	let releaseOperation: Promise<void> | undefined;
	return () => {
		// Never retry a numeric OS handle after an ambiguous close: it could have
		// been reused. Concurrent and repeated releases share the same outcome.
		releaseOperation ??= (async () => {
			await execute(
				win32.toNamespacedPath(retained),
				["--quarterdeck-release-mutation", lockPath, acquired.handle, acquired.birth],
				{ windowsHide: true, timeout: 15000, maxBuffer: 4096 },
			);
			await rm(directory, { recursive: true, force: true });
		})();
		return releaseOperation;
	};
}
