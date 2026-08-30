import { createReadStream, createWriteStream } from "node:fs";
import { chmod } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import {
	type EnsurePrivateDirectoryOptions,
	ensurePrivateDirectories,
	PrivateDirectoryAclError,
	type WindowsPrivateAclCommandResult,
	type WindowsPrivateAclCommandRunner,
} from "../core/private-directory";

export type { WindowsPrivateAclCommandResult, WindowsPrivateAclCommandRunner };

export interface EnsurePrivateDiagnosticDirectoryOptions extends EnsurePrivateDirectoryOptions {}

export class DiagnosticAclError extends Error {
	readonly code = "DiagnosticAclError";

	constructor() {
		super("Could not apply a private Windows ACL to diagnostic storage.");
		this.name = "DiagnosticAclError";
	}
}

/**
 * Creates a diagnostic-owned directory before any sensitive content is written.
 * Windows receives an exact protected DACL containing only the current user and
 * LocalSystem; descendants inherit that DACL. POSIX platforms retain the
 * existing owner-only mode contract.
 */
export async function ensurePrivateDiagnosticDirectory(
	path: string,
	options: EnsurePrivateDiagnosticDirectoryOptions = {},
): Promise<void> {
	await ensurePrivateDiagnosticDirectories([path], options);
}

/** Applies one private ACL operation to a set of diagnostic-owned directories. */
export async function ensurePrivateDiagnosticDirectories(
	paths: readonly string[],
	options: EnsurePrivateDiagnosticDirectoryOptions = {},
): Promise<void> {
	try {
		await ensurePrivateDirectories(paths, options);
	} catch (error) {
		if (error instanceof PrivateDirectoryAclError) throw new DiagnosticAclError();
		throw error;
	}
}

/**
 * Copies content into a newly created destination so Windows inherits the
 * private parent DACL instead of cloning the source file's security descriptor.
 */
export async function copyPrivateDiagnosticFile(source: string, destination: string): Promise<void> {
	await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
	if (process.platform !== "win32") await chmod(destination, 0o600);
}
