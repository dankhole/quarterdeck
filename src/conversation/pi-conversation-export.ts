import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { areFileSystemPathsEqual } from "../core/path-comparison.js";
import { isNodeError } from "../fs/node-error.js";
import { openValidatedContainedRegularFile, validateOpenedContainedRegularFile } from "../fs/validated-file-open.js";
import { ConversationExportError } from "./codex-conversation-export.js";
import { readIncrementalJsonl } from "./incremental-jsonl-reader.js";
import { isJsonObject } from "./provider-record-utils.js";
import type { ConversationSourceHint } from "./types.js";

const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_RECORDS = 500_000;
const MAX_RAW_RECORD_BYTES = 16 * 1024 * 1024;
const READ_DEADLINE_MS = 30_000;
const INVALID_SOURCE = "The saved Pi conversation file is not valid. Conversation was not copied.";
const UNREADABLE = "A saved Pi message is unreadable or exceeds the 16 MB record limit. Conversation was not copied.";
const LINK_ERROR = "Some saved Pi messages could not be linked. Conversation was not copied.";

interface ExportEntry {
	id: string;
	parentId: string | null;
	block: string | null;
}

/** Only human prompts and assistant text are copied, matching Claude/Codex exports. */
function messageText(content: unknown, role: "user" | "assistant"): string | null {
	if (role === "user" && typeof content === "string") return content.trim() ? content : null;
	if (!Array.isArray(content)) throw new ConversationExportError(UNREADABLE);
	const texts: string[] = [];
	for (const block of content) {
		if (!isJsonObject(block)) throw new ConversationExportError(UNREADABLE);
		if (block.type === "text" && typeof block.text === "string") {
			if (block.text.trim()) texts.push(block.text);
		} else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			// Do not copy base64 image data.
		} else if (role === "assistant" && block.type === "thinking" && typeof block.thinking === "string") {
			// Reasoning is not a visible assistant response.
		} else if (
			role === "assistant" &&
			block.type === "toolCall" &&
			typeof block.id === "string" &&
			typeof block.name === "string" &&
			isJsonObject(block.arguments)
		) {
			// Tool arguments and results are deliberately excluded.
		} else throw new ConversationExportError(UNREADABLE);
	}
	return texts.length ? texts.join("\n\n") : null;
}

function parseEntry(value: Record<string, unknown>, byId: ReadonlyMap<string, ExportEntry>): ExportEntry {
	if (
		typeof value.id !== "string" ||
		!value.id ||
		byId.has(value.id) ||
		!(value.parentId === null || (typeof value.parentId === "string" && byId.has(value.parentId)))
	) {
		throw new ConversationExportError(LINK_ERROR);
	}
	let block: string | null = null;
	if (value.type === "message") {
		const message = value.message;
		if (!isJsonObject(message)) throw new ConversationExportError(UNREADABLE);
		if (message.role === "user" || message.role === "assistant") {
			const text = messageText(message.content, message.role);
			if (text) block = `## ${message.role === "user" ? "You" : "Pi"}\n\n${text}`;
		} else if (
			!["system", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(
				String(message.role),
			)
		) {
			throw new ConversationExportError(UNREADABLE);
		}
	} else if (value.type === "compaction") {
		if (typeof value.summary !== "string" || typeof value.firstKeptEntryId !== "string")
			throw new ConversationExportError(UNREADABLE);
		block = "[Context compacted]";
	} else if (value.type === "branch_summary") {
		if (typeof value.summary !== "string" || typeof value.fromId !== "string")
			throw new ConversationExportError(UNREADABLE);
		block = "[Branch changed]";
	} else if (
		![
			"model_change",
			"thinking_level_change",
			"usage",
			"custom",
			"custom_message",
			"context_edit",
			"label",
			"session_info",
		].includes(String(value.type))
	) {
		throw new ConversationExportError(UNREADABLE);
	}
	return { id: value.id, parentId: value.parentId, block };
}

/**
 * Reads only the exact file reported by an authenticated current-launch Pi hook.
 * Its directory is provider-selected (including native storage overrides), not a
 * browser-supplied read root. Never invokes Pi/SessionManager: loading via that
 * API can migrate and rewrite history. The last persisted entry is Pi's saved
 * leaf; in-memory tree navigation without a subsequent append is not persisted.
 */
export async function exportPiConversation(input: {
	sessionId: string;
	sessionInstanceId: string;
	launchPath: string;
	hint: ConversationSourceHint | null;
}): Promise<string> {
	const deadlineAt = Date.now() + READ_DEADLINE_MS;
	const hint = input.hint;
	if (
		hint?.providerId !== "pi" ||
		hint.providerSessionId !== input.sessionId ||
		hint.sessionInstanceId !== input.sessionInstanceId
	)
		throw new ConversationExportError("No saved Pi conversation source is available for this launch yet.");
	if (!isAbsolute(hint.sourcePath) || hint.sourcePath.length > 4096) throw new ConversationExportError(INVALID_SOURCE);
	// Canonicalize the parent, not the final component: symlinks must not redirect
	// the provider-reported file to an unrelated file outside that directory.
	let canonicalRoot: string;
	let canonicalPath: string;
	try {
		canonicalRoot = await realpath(dirname(hint.sourcePath));
		canonicalPath = await realpath(hint.sourcePath);
	} catch (error) {
		if (isNodeError(error, "ENOENT"))
			throw new ConversationExportError("No saved messages are available to copy yet.");
		throw error;
	}
	const opened = await openValidatedContainedRegularFile({ canonicalRoot, canonicalPath });
	if (opened.status !== "opened") throw new ConversationExportError(INVALID_SOURCE);
	const { fileHandle, fileStat } = opened;
	try {
		if (!Number.isSafeInteger(fileStat.size) || fileStat.size > MAX_SOURCE_BYTES)
			throw new ConversationExportError("This conversation exceeds the 128 MB history read limit.");
		const launchPath = await realpath(input.launchPath);
		const byId = new Map<string, ExportEntry>();
		let leaf: ExportEntry | null = null;
		let headerCwd: string | null = null;
		let failure: ConversationExportError | null = null;
		const result = await readIncrementalJsonl({
			fileHandle,
			fileSize: fileStat.size,
			position: { offset: 0, partial: Buffer.alloc(0), discardUntilNewline: false },
			maxBytes: fileStat.size,
			maxRecords: MAX_SOURCE_RECORDS,
			maxRawRecordBytes: MAX_RAW_RECORD_BYTES,
			chunkBytes: 256 * 1024,
			deadlineAt,
			onRecord(record) {
				if (failure) return;
				try {
					if (record.kind !== "parsed" || !isJsonObject(record.value))
						throw new ConversationExportError(UNREADABLE);
					const value = record.value;
					if (headerCwd === null) {
						if (
							value.type !== "session" ||
							value.id !== input.sessionId ||
							value.version !== 3 ||
							typeof value.cwd !== "string" ||
							!isAbsolute(value.cwd)
						)
							throw new ConversationExportError(INVALID_SOURCE);
						headerCwd = value.cwd;
						return;
					}
					leaf = parseEntry(value, byId);
					byId.set(leaf.id, leaf);
				} catch (error) {
					failure = error instanceof ConversationExportError ? error : new ConversationExportError(UNREADABLE);
				}
			},
		});
		if (failure) throw failure;
		if (Date.now() > deadlineAt)
			throw new ConversationExportError("Reading the full conversation took too long. Try again.");
		if (result.sourceChanged)
			throw new ConversationExportError("Conversation history changed while copying. Try again.");
		if (result.position.offset < fileStat.size)
			throw new ConversationExportError("This conversation exceeds the history copy limit.");
		if (result.position.partial.length || result.position.discardUntilNewline)
			throw new ConversationExportError(UNREADABLE);
		if (headerCwd === null || !areFileSystemPathsEqual(launchPath, await realpath(headerCwd)))
			throw new ConversationExportError(INVALID_SOURCE);
		const blocks: string[] = [];
		let bytes = 0;
		let messages = 0;
		let entry: ExportEntry | undefined | null = leaf;
		while (entry) {
			if (Date.now() > deadlineAt)
				throw new ConversationExportError("Reading the full conversation took too long. Try again.");
			if (entry.block) {
				bytes += Buffer.byteLength(entry.block, "utf8") + 2;
				if (bytes > MAX_EXPORT_BYTES)
					throw new ConversationExportError("This conversation exceeds the 8 MB copy limit.");
				blocks.push(entry.block);
				if (entry.block.startsWith("## ")) messages++;
			}
			entry = entry.parentId === null ? null : byId.get(entry.parentId);
		}
		if (!messages) throw new ConversationExportError("No saved messages are available to copy yet.");
		const validation = await validateOpenedContainedRegularFile({
			canonicalRoot,
			canonicalPath,
			pathStat: fileStat,
			fileHandle,
		});
		const currentPath = await realpath(hint.sourcePath);
		const currentStat = await lstat(currentPath);
		if (
			validation.status !== "valid" ||
			!areFileSystemPathsEqual(currentPath, canonicalPath) ||
			currentStat.dev !== fileStat.dev ||
			currentStat.ino !== fileStat.ino ||
			currentStat.size !== fileStat.size ||
			currentStat.mtimeMs !== fileStat.mtimeMs ||
			currentStat.ctimeMs !== fileStat.ctimeMs
		)
			throw new ConversationExportError("Conversation history changed while copying. Try again.");
		return `${blocks.reverse().join("\n\n")}\n`;
	} catch (error) {
		if (error instanceof ConversationExportError) throw error;
		throw new ConversationExportError(INVALID_SOURCE);
	} finally {
		await fileHandle.close().catch(() => undefined);
	}
}
