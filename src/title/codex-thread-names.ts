import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { openValidatedContainedRegularFile } from "../fs/validated-file-open";

export const CODEX_THREAD_NAME_READ_LIMIT_BYTES = 1024 * 1024;
const MAX_TITLE_LENGTH = 80;

function hasControlCharacters(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 32 || code === 127;
	});
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * Native Codex appends title changes to its profile's session_index.jsonl.
 * Read only complete records in a bounded tail, with the latest valid name
 * winning. This does not start or subscribe to an agent conversation.
 */
export async function readCodexThreadNames(
	codexHome: string,
	threadIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	const seen = new Set<string>();
	if (threadIds.size === 0) return names;
	try {
		const canonicalRoot = await realpath(codexHome);
		const source = await openValidatedContainedRegularFile({
			canonicalRoot,
			canonicalPath: join(canonicalRoot, "session_index.jsonl"),
		});
		if (source.status !== "opened") {
			throw new Error(`Invalid Codex thread-name index: ${source.reason}`);
		}
		try {
			const size = source.fileStat.size;
			const start = Math.max(0, size - CODEX_THREAD_NAME_READ_LIMIT_BYTES);
			const buffer = Buffer.alloc(size - start);
			let bytesRead = 0;
			while (bytesRead < buffer.length) {
				const chunk = await source.fileHandle.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
				if (chunk.bytesRead === 0) break;
				bytesRead += chunk.bytesRead;
			}
			const text = buffer.subarray(0, bytesRead).toString("utf8");
			const firstRecord = start === 0 ? 0 : text.indexOf("\n") + 1;
			const lastRecordEnd = text.lastIndexOf("\n");
			if (lastRecordEnd < firstRecord) return names;
			const lines = text.slice(firstRecord, lastRecordEnd).split("\n");
			for (let index = lines.length - 1; index >= 0; index -= 1) {
				let record: unknown;
				try {
					record = JSON.parse(lines[index]);
				} catch {
					continue;
				}
				if (!record || typeof record !== "object" || !("id" in record) || !("thread_name" in record)) continue;
				const { id, thread_name: rawName } = record;
				if (
					typeof id !== "string" ||
					id.length === 0 ||
					id.length > 512 ||
					hasControlCharacters(id) ||
					!threadIds.has(id) ||
					seen.has(id) ||
					(rawName !== null && typeof rawName !== "string")
				)
					continue;
				const name = rawName?.replace(/\s+/gu, " ").trim() ?? "";
				if (hasControlCharacters(name)) continue;
				// An explicit cleared name must not resurrect an older index entry.
				seen.add(id);
				if (name) names.set(id, Array.from(name).slice(0, MAX_TITLE_LENGTH).join("").trimEnd());
				if (seen.size === threadIds.size) break;
			}
			return names;
		} finally {
			await source.fileHandle.close();
		}
	} catch (error) {
		if (isMissingPath(error)) return names;
		throw error;
	}
}
