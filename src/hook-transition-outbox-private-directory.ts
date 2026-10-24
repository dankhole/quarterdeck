import { realpath, stat } from "node:fs/promises";

import { diagnosticErrorClassOf } from "./core/diagnostic-error-class.js";
import { type EnsurePrivateDirectoryOptions, ensurePrivateDirectory } from "./core/private-directory.js";
import { createTaggedLogger } from "./core/runtime-logger.js";
import { getOutboxDirectoryPath } from "./hook-transition-outbox-core.js";

const log = createTaggedLogger("hook-outbox");

/** Runtime-only, once per launch; never import this module from the hook CLI. */
export async function prepareHookTransitionOutboxDirectoryCapability(
	options: EnsurePrivateDirectoryOptions = {},
): Promise<string | undefined> {
	// POSIX hooks can enforce directory privacy themselves without a subprocess.
	if ((options.platform ?? process.platform) !== "win32") return undefined;
	try {
		const directory = getOutboxDirectoryPath();
		await ensurePrivateDirectory(directory, options);
		const canonicalPath = await realpath(directory);
		const identity = await stat(canonicalPath, { bigint: true });
		if (!identity.isDirectory() || identity.ino === 0n) return undefined;
		// This launch environment is the trusted handoff, not a marker in a
		// potentially unprotected directory. Bind it to the prepared object so
		// path overrides or directory replacement cannot reuse the capability.
		return JSON.stringify({
			version: 1,
			path: canonicalPath,
			dev: identity.dev.toString(),
			ino: identity.ino.toString(),
		});
	} catch (error) {
		log.warn("completion text retention unavailable for launch", { errorClass: diagnosticErrorClassOf(error) });
		// Hooks still durably enqueue their content-free lifecycle envelope.
		return undefined;
	}
}
