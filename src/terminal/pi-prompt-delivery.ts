import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	assertRuntimeWriteAdmission,
	RuntimeWriteAdmissionError,
	withRuntimeWriteOperation,
} from "../state/runtime-write-admission";
import { createPiPromptDirectory } from "./pi-prompt-storage";

// The final PTY guard separately checks the complete command and environment.
export const PI_INLINE_PROMPT_MAX_BYTES = 8 * 1024;
// Leave ample quoting/launcher headroom under Windows cmd's 8,191-unit cap.
export const PI_WINDOWS_INLINE_PROMPT_MAX_BYTES = 1024;
export const PI_PROMPT_MAX_BYTES = 8 * 1024 * 1024;

export const PI_FILE_PROMPT_INSTRUCTION = "The attached prompt.txt file contains the task instructions. Follow them.";

export type PreparedPiPromptDelivery =
	| { args: [] | [string]; cleanup?: undefined }
	| {
			args: [string, string];
			/** Retain the file until the native process exits or is disposed. */
			cleanup: () => Promise<void>;
	  };

function createPromptCleanup(directory: string): () => Promise<void> {
	let pending: Promise<void> | undefined;
	return () => {
		pending ??= withRuntimeWriteOperation([directory], async () => {
			assertRuntimeWriteAdmission(directory);
			await rm(directory, { recursive: true, force: true });
		}).catch((error: unknown) => {
			pending = undefined;
			if (error instanceof RuntimeWriteAdmissionError) throw error;
			throw new Error(
				"Could not remove private Pi prompt storage. Check Quarterdeck state-home access and retry cleanup.",
			);
		});
		return pending;
	};
}

/**
 * Pi 1.5.2 parses @file even after --, reads it before starting the first turn,
 * and includes all text in its native <file> wrapper. It does not ask a tool to
 * read the file. Preserve the adapter's existing outer-whitespace trimming.
 */
export async function preparePiPromptDelivery(
	prompt: string,
	options: { platform?: NodeJS.Platform; additionalFileText?: readonly string[] } = {},
): Promise<PreparedPiPromptDelivery> {
	const trimmed = prompt.trim();
	if (!trimmed) return { args: [] };
	const bytes = Buffer.byteLength(trimmed, "utf8");
	if (bytes > PI_PROMPT_MAX_BYTES) {
		throw new Error(
			"Pi task prompt exceeds the 8 MiB UTF-8 limit. Shorten the task prompt or split it into smaller tasks.",
		);
	}
	// A leading @ would otherwise expand as a filename, including after --.
	// NUL cannot be passed in argv but is safe in native text-file input.
	const windows = (options.platform ?? process.platform) === "win32";
	const inlineMaxBytes = windows ? PI_WINDOWS_INLINE_PROMPT_MAX_BYTES : PI_INLINE_PROMPT_MAX_BYTES;
	const windowsQuotingHazard = windows && /["\r\n]|\\$/u.test(trimmed);
	if (bytes <= inlineMaxBytes && !trimmed.startsWith("@") && !trimmed.includes("\0") && !windowsQuotingHazard) {
		return { args: [trimmed] };
	}

	// Only positional message text belongs here. Native @file/image references
	// remain CLI arguments; the adapter partitions them using Pi's own prefix rule.
	const fileText = options.additionalFileText?.length
		? [trimmed, "Additional launch text:", ...options.additionalFileText].join("\n\n")
		: trimmed;
	if (Buffer.byteLength(fileText, "utf8") > PI_PROMPT_MAX_BYTES) {
		throw new Error(
			"Pi task prompt and custom positional text exceed the 8 MiB UTF-8 limit. Shorten the task prompt or custom arguments.",
		);
	}
	let cleanup: (() => Promise<void>) | undefined;
	try {
		const directory = await createPiPromptDirectory();
		cleanup = createPromptCleanup(directory);
		// The storage owner guarantees POSIX modes / a protected Windows DACL
		// before returning this launch directory or accepting any content.
		const path = join(directory, "prompt.txt");
		// Pi sniffs image magic even for .txt files. A BOM forces text treatment
		// (including prompts starting GIF89a); native stripBom removes it again.
		await withRuntimeWriteOperation([directory], async () => {
			assertRuntimeWriteAdmission(directory);
			await writeFile(path, `\uFEFF${fileText}`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		});
		// Pi normalizes Unicode spaces in bare paths. A percent-encoded file URL
		// preserves the exact path, including those spaces, #, %, and Windows drives.
		return { args: [`@${pathToFileURL(path).href}`, PI_FILE_PROMPT_INSTRUCTION], cleanup };
	} catch (error) {
		try {
			await cleanup?.();
		} catch (cleanupError) {
			// A stale runtime must leave private content for the next admitted
			// sweep. Preserve the typed ownership failure, not a storage diagnosis.
			if (error instanceof RuntimeWriteAdmissionError) throw error;
			if (cleanupError instanceof RuntimeWriteAdmissionError) throw cleanupError;
			throw new Error(
				"Could not prepare or remove private Pi prompt storage. Check Quarterdeck state-home permissions and free space before retrying.",
			);
		}
		if (error instanceof RuntimeWriteAdmissionError) throw error;
		// Filesystem/ACL errors can contain private paths or payloads; do not
		// propagate their messages or causes into launch diagnostics.
		throw new Error(
			"Could not prepare a private Pi prompt file. Check Quarterdeck state-home permissions and free space, then retry.",
		);
	}
}
