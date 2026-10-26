import { constants } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { areFileSystemPathsEqual } from "../core/path-comparison.js";
import { openValidatedContainedRegularFile, resolveReadOnlyFileOpenFlags } from "../fs/validated-file-open.js";
import { isJsonObject } from "./provider-record-utils.js";
import type { ConversationSourceHint } from "./types.js";

/** Native authenticated hints, not default storage roots, select Pi's exact file. */
export async function openPiProgressSource(hint: ConversationSourceHint) {
	if (hint.providerId !== "pi" || !isAbsolute(hint.sourcePath) || hint.sourcePath.length > 4096) return null;
	const canonicalRoot = await realpath(dirname(hint.sourcePath));
	const canonicalPath = await realpath(hint.sourcePath);
	const opened = await openValidatedContainedRegularFile({
		canonicalRoot,
		canonicalPath,
		// A POSIX FIFO swapped in after lstat must not block before regular-file
		// validation can reject its handle. O_NONBLOCK has no effect on regular files.
		openFlags: resolveReadOnlyFileOpenFlags() | (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
	});
	if (opened.status !== "opened") return null;
	return {
		providerId: "pi" as const,
		providerSessionId: hint.providerSessionId,
		canonicalRoot,
		canonicalPath,
		fileHandle: opened.fileHandle,
	};
}

export async function isValidPiProgressHeader(value: unknown, sessionId: string, launchPath: string): Promise<boolean> {
	return (
		isJsonObject(value) &&
		value.type === "session" &&
		value.version === 3 &&
		value.id === sessionId &&
		typeof value.cwd === "string" &&
		isAbsolute(value.cwd) &&
		areFileSystemPathsEqual(await realpath(value.cwd), await realpath(launchPath))
	);
}
