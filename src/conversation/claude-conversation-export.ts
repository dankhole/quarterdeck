import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parseClaudeHistoryRecord } from "./claude-history-parser.js";
import { reconstructClaudeHistory } from "./claude-history-reconstruction.js";
import { ConversationExportError } from "./codex-conversation-export.js";
import { readIncrementalJsonl } from "./incremental-jsonl-reader.js";
import { DEFAULT_CONVERSATION_READ_LIMITS } from "./limits.js";
import { isJsonObject, readString } from "./provider-record-utils.js";
import { ProviderConversationSourceLocator } from "./provider-source-locator.js";
import type { ConversationSourceHint, ParsedProviderRecordAtOffset, ValidatedConversationSource } from "./types.js";

// Output, deadline, and history-volume limits match the Codex export.
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const READ_DEADLINE_MS = 30_000;
// Claude transcripts also persist tool inputs and results, so the raw source
// is bounded separately from the copied text.
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_RECORDS = 500_000;
const MAX_RAW_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_COMPACTION_SEGMENTS = 1_000;
const READ_CHUNK_BYTES = 256 * 1024;

/** The Claude profile root a native task's process resolves (CLAUDE_CONFIG_DIR or ~/.claude). */
export function resolveClaudeTaskProfileRoot(
	launchPath: string,
	profile: { CLAUDE_CONFIG_DIR?: string; HOME?: string },
): string {
	return resolve(launchPath, profile.CLAUDE_CONFIG_DIR?.trim() || join(profile.HOME?.trim() || homedir(), ".claude"));
}

export function resolveClaudeTaskHistoryRoots(profileRoot: string): string[] {
	return [join(profileRoot, "projects")];
}

interface ExportRecord extends ParsedProviderRecordAtOffset {
	/** Claude's compaction bridge to the pre-compaction leaf; absent on ordinary records. */
	logicalParentNativeId: string | null;
}

async function locateClaudeSession(input: {
	profileRoot: string;
	sessionId: string;
	hint: ConversationSourceHint | null;
	deadlineAt: number;
}): Promise<ValidatedConversationSource> {
	const locator = new ProviderConversationSourceLocator(
		"claude",
		resolveClaudeTaskHistoryRoots(input.profileRoot),
		DEFAULT_CONVERSATION_READ_LIMITS,
	);
	const lookup = await locator.locate({
		projectId: "",
		taskId: "",
		providerSessionId: input.sessionId,
		deadlineAt: input.deadlineAt,
		hint: input.hint,
	});
	if (lookup.status === "available") return lookup.source;
	if (lookup.status === "invalid_source")
		throw new ConversationExportError(
			"The saved Claude conversation file is not valid. Conversation was not copied.",
		);
	if (lookup.status === "unavailable" && lookup.reason === "deadline_exceeded")
		throw new ConversationExportError("Reading the full conversation took too long. Try again.");
	if (lookup.status === "unavailable" && lookup.reason === "source_lookup_limit")
		throw new ConversationExportError("Could not find the saved Claude conversation. Try again.");
	throw new ConversationExportError("No saved Claude conversation is available yet.");
}

async function readClaudeSessionRecords(
	source: ValidatedConversationSource,
	deadlineAt: number,
): Promise<{ records: ExportRecord[]; unreadableOffsets: number[] }> {
	if (source.fileSize > MAX_SOURCE_BYTES)
		throw new ConversationExportError("This conversation exceeds the 128 MB history read limit.");
	const records: ExportRecord[] = [];
	const unreadableOffsets: number[] = [];
	const result = await readIncrementalJsonl({
		fileHandle: source.fileHandle,
		fileSize: source.fileSize,
		position: { offset: 0, partial: Buffer.alloc(0), discardUntilNewline: false },
		maxBytes: source.fileSize,
		maxRecords: MAX_SOURCE_RECORDS,
		maxRawRecordBytes: MAX_RAW_RECORD_BYTES,
		chunkBytes: READ_CHUNK_BYTES,
		deadlineAt,
		onRecord: (record) => {
			if (record.kind !== "parsed") {
				unreadableOffsets.push(record.byteOffset);
				return;
			}
			// Malformed messages keep their lineage; selection rejects them only on the active chain.
			records.push({
				record: parseClaudeHistoryRecord(record.value),
				byteOffset: record.byteOffset,
				logicalParentNativeId: isJsonObject(record.value) ? readString(record.value, "logicalParentUuid") : null,
			});
		},
	});
	if (result.sourceChanged)
		throw new ConversationExportError("Conversation history changed while copying. Try again.");
	// A trailing record without its newline is still being written and stays in
	// `position.partial`; every record before it was read completely.
	if (result.position.offset < source.fileSize) {
		if (Date.now() > deadlineAt)
			throw new ConversationExportError("Reading the full conversation took too long. Try again.");
		throw new ConversationExportError("This conversation exceeds the history copy limit.");
	}
	return { records, unreadableOffsets };
}

const LINK_ERROR = "Some saved Claude messages could not be linked. Conversation was not copied.";
const UNREADABLE_RECORD_ERROR =
	"A saved Claude message is unreadable or exceeds the 16 MB record limit. Conversation was not copied.";

/**
 * Unreadable records are tolerated only when provably off the active chain: a
 * missing ancestor already fails reconstruction, so the remaining risk is an
 * unreadable record newer than the leaf, or any record in an unlinked legacy file.
 */
function assertActiveHistoryReadable(
	records: readonly ExportRecord[],
	active: readonly ExportRecord[],
	unreadableOffsets: readonly number[],
): void {
	if (active.some(({ record }) => record.item.kind === "malformed"))
		throw new ConversationExportError(UNREADABLE_RECORD_ERROR);
	if (unreadableOffsets.length === 0) return;
	const linked = records.some(({ record }) => record.lineage?.parentFieldPresent && !record.lineage.isSidechain);
	const leafOffset = active.at(-1)?.byteOffset ?? -1;
	if (!linked || unreadableOffsets.some((offset) => offset > leafOffset))
		throw new ConversationExportError(UNREADABLE_RECORD_ERROR);
}

function findCompactionBridge(oldest: ExportRecord, byNativeId: ReadonlyMap<string, ExportRecord>): string | null {
	const item = oldest.record.item;
	if (item.kind !== "boundary" || item.boundary !== "compacted") return null;
	if (oldest.logicalParentNativeId) return oldest.logicalParentNativeId;
	// A compact summary message links to the compact_boundary record, which carries the bridge.
	const parentId = oldest.record.lineage?.parentNativeId;
	return (parentId && byNativeId.get(parentId)?.logicalParentNativeId) || null;
}

/** Selects the active chain, following compaction bridges so pre-compaction history is included. */
function selectActiveHistory(records: readonly ExportRecord[], linkError: string): ExportRecord[] {
	const byNativeId = new Map<string, ExportRecord>();
	const indexById = new Map<string, number>();
	records.forEach((candidate, index) => {
		const nativeId = candidate.record.lineage?.nativeId;
		if (nativeId) {
			byNativeId.set(nativeId, candidate);
			indexById.set(nativeId, index);
		}
	});
	const segments: ExportRecord[][] = [];
	let end = records.length;
	for (let segment = 0; segment < MAX_COMPACTION_SEGMENTS; segment++) {
		const reconstructed = reconstructClaudeHistory(records.slice(0, end));
		if (reconstructed.incomplete) throw new ConversationExportError(linkError);
		const selected = reconstructed.records as ExportRecord[];
		segments.unshift(selected);
		const oldest = selected[0];
		const bridge = oldest ? findCompactionBridge(oldest, byNativeId) : null;
		if (!oldest || !bridge) return segments.flat();
		const bridgeIndex = indexById.get(bridge);
		const oldestIndex = records.indexOf(oldest);
		if (bridgeIndex === undefined) throw new ConversationExportError(linkError);
		if (bridgeIndex >= oldestIndex)
			throw new ConversationExportError("Claude could not read the full conversation. Try again.");
		end = bridgeIndex + 1;
	}
	throw new ConversationExportError("This conversation exceeds the history copy limit.");
}

function formatClaudeConversation(records: readonly ExportRecord[]): string[] {
	const blocks: string[] = [];
	for (const { record } of records) {
		const { item } = record;
		if (item.kind === "message") {
			blocks.push(`## ${item.role === "user" ? "You" : "Claude"}\n\n${item.text}`);
		} else if (item.kind === "boundary" && item.boundary === "compacted" && blocks.at(-1) !== "[Context compacted]") {
			blocks.push("[Context compacted]");
		}
	}
	return blocks;
}

/**
 * Reads the task's exact persisted Claude session JSONL only. Never launches,
 * resumes, or writes to Claude. Fails explicitly instead of copying a partial
 * or foreign conversation.
 */
export async function exportClaudeConversation(input: {
	profileRoot: string;
	sessionId: string;
	hint: ConversationSourceHint | null;
}): Promise<string> {
	const deadlineAt = Date.now() + READ_DEADLINE_MS;
	const source = await locateClaudeSession({ ...input, deadlineAt });
	try {
		const { records, unreadableOffsets } = await readClaudeSessionRecords(source, deadlineAt);
		const active = selectActiveHistory(
			records,
			// A missing ancestor is most likely the unreadable record itself.
			unreadableOffsets.length ? UNREADABLE_RECORD_ERROR : LINK_ERROR,
		);
		assertActiveHistoryReadable(records, active, unreadableOffsets);
		const foreign = active.some(
			({ record }) =>
				(record.providerSessionId !== null && record.providerSessionId.trim() !== input.sessionId) ||
				(record.item.kind === "message" && !record.providerSessionId),
		);
		if (foreign)
			throw new ConversationExportError(
				"The saved Claude conversation belongs to a different session. Conversation was not copied.",
			);
		const blocks = formatClaudeConversation(active);
		if (!blocks.some((block) => block.startsWith("## ")))
			throw new ConversationExportError("No saved messages are available to copy yet.");
		const text = `${blocks.join("\n\n")}\n`;
		if (Buffer.byteLength(text, "utf8") > MAX_EXPORT_BYTES)
			throw new ConversationExportError("This conversation exceeds the 8 MB copy limit.");
		return text;
	} finally {
		await source.fileHandle.close().catch(() => undefined);
	}
}
