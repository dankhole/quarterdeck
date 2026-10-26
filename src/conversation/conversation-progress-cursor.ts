import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { type FileHandle, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { areFileSystemPathsEqual } from "../core/path-comparison.js";
import { validateOpenedContainedRegularFile } from "../fs/validated-file-open.js";
import { readJsonlHeadRecord } from "./bounded-jsonl-head.js";
import { parseClaudeHistoryRecord } from "./claude-history-parser.js";
import { createCodexHistoryRecordParser, parseCodexSessionHeader } from "./codex-history-parser.js";
import { type IncrementalJsonlPosition, readIncrementalJsonl } from "./incremental-jsonl-reader.js";
import { DEFAULT_CONVERSATION_READ_LIMITS } from "./limits.js";
import { parsePiProgressEntry } from "./pi-progress-parser.js";
import { isValidPiProgressHeader, openPiProgressSource } from "./pi-progress-source.js";
import { isJsonObject, readString } from "./provider-record-utils.js";
import {
	type ConversationHistoryRoots,
	ProviderConversationSourceLocator,
	resolveDefaultConversationHistoryRoots,
} from "./provider-source-locator.js";
import { normalizeConversationText } from "./text-normalization.js";
import type { ConversationSourceHint } from "./types.js";

export interface ConversationProgressReadLimits {
	maxSourceBytes: number;
	maxRecords: number;
	maxRawRecordBytes: number;
	chunkBytes: number;
	deadlineMs: number;
}

export const PROGRESS_READ_LIMITS: Readonly<ConversationProgressReadLimits> = Object.freeze({
	maxSourceBytes: 128 * 1024,
	maxRecords: 256,
	maxRawRecordBytes: 1024 * 1024,
	chunkBytes: 32 * 1024,
	deadlineMs: 100,
});
const MAX_PREVIEW_RECORD_BYTES = 32 * 1024;
const MAX_PI_RECENT_IDS = 4096;

interface PreviewRecordFingerprint {
	byteOffset: number;
	byteLength: number;
	digest: string;
}

export interface ConversationProgressReadResult {
	text: string | null;
	hasMore: boolean;
	sourceBytesExamined: number;
}

export interface ConversationProgressCursor {
	beginEpoch(since: number): void;
	pause(): void;
	read(): Promise<ConversationProgressReadResult>;
}

interface CursorState extends IncrementalJsonlPosition {
	fileIdentity: string | null;
	anchor: Buffer;
	headerValidated: boolean;
	latest: string | null;
	blocked: boolean;
	claudeLeafId: string | null;
	invalidated: boolean;
	previewRecord: PreviewRecordFingerprint | null;
	piHeaderRecord: PreviewRecordFingerprint | null;
	piLeafId: string | null;
	piPreviewEntryId: string | null;
	piRecentIds: Set<string>;
	piSnapshot: { size: number; mtimeMs: number; ctimeMs: number } | null;
}

function initialState(): CursorState {
	return {
		offset: 0,
		partial: Buffer.alloc(0),
		discardUntilNewline: false,
		fileIdentity: null,
		anchor: Buffer.alloc(0),
		headerValidated: false,
		latest: null,
		blocked: false,
		claudeLeafId: null,
		invalidated: false,
		previewRecord: null,
		piHeaderRecord: null,
		piLeafId: null,
		piPreviewEntryId: null,
		piRecentIds: new Set(),
		piSnapshot: null,
	};
}

async function readAnchor(handle: FileHandle, offset: number): Promise<Buffer> {
	const length = Math.min(64, offset);
	const bytes = Buffer.alloc(length);
	const { bytesRead } = await handle.read(bytes, 0, length, offset - length);
	return bytes.subarray(0, bytesRead);
}

function identityOf(path: string, stat: Stats): string {
	return JSON.stringify([path, stat.dev, stat.ino, stat.birthtimeMs]);
}

/** Exact-source forward reading. Scheduling and runtime lifecycle belong to the caller. */
export function createConversationProgressCursor(input: {
	hint: ConversationSourceHint;
	since: number;
	/** Required for Pi: caller-owned identity of the authenticated current launch. */
	sessionInstanceId?: string;
	launchPath?: string;
	roots?: ConversationHistoryRoots;
	limits?: Partial<ConversationProgressReadLimits>;
}): ConversationProgressCursor {
	const isPi = input.hint.providerId === "pi";
	if (
		isPi &&
		(!input.sessionInstanceId ||
			input.hint.sessionInstanceId !== input.sessionInstanceId ||
			!input.launchPath ||
			!isAbsolute(input.launchPath) ||
			!Number.isFinite(input.since))
	) {
		return {
			beginEpoch() {},
			pause() {},
			async read() {
				return { text: null, hasMore: false, sourceBytesExamined: 0 };
			},
		};
	}
	const limits = { ...PROGRESS_READ_LIMITS, ...input.limits };
	const maxPreviewRecordBytes = Math.min(MAX_PREVIEW_RECORD_BYTES, Math.floor(limits.maxSourceBytes / 4));
	const piHeaderBudget = isPi ? Math.min(8 * 1024, Math.floor(limits.maxSourceBytes / 16)) : 0;
	const roots = input.roots ?? resolveDefaultConversationHistoryRoots();
	const locator =
		input.hint.providerId === "pi"
			? null
			: new ProviderConversationSourceLocator(input.hint.providerId, roots[input.hint.providerId], {
					...DEFAULT_CONVERSATION_READ_LIMITS,
					maxLookupEntries: 0,
				});
	let state = initialState();
	let since = input.since;
	let generation = 0;

	function pause(): void {
		generation += 1;
		// Keep the small identity anchor, but skip any unfinished prior-epoch line.
		state.discardUntilNewline ||= state.partial.length > 0;
		state.partial = Buffer.alloc(0);
		state.headerValidated = false;
		state.latest = null;
		state.blocked = false;
		state.piPreviewEntryId = null;
		state.piRecentIds = new Set();
	}

	async function read(): Promise<ConversationProgressReadResult> {
		const requestedGeneration = generation;
		const epochSince = since;
		let next = { ...state, piRecentIds: new Set(state.piRecentIds) };
		function clearPiPreview(): void {
			next.latest = null;
			next.previewRecord = null;
			next.piPreviewEntryId = null;
		}
		const deadlineAt = Date.now() + limits.deadlineMs;
		let sourceBytesExamined = 0;
		async function matchesPreviewRecord(
			handle: FileHandle,
			fingerprint: PreviewRecordFingerprint | null,
		): Promise<boolean> {
			if (!fingerprint) return true;
			const bytes = Buffer.alloc(fingerprint.byteLength);
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, fingerprint.byteOffset);
			sourceBytesExamined += bytesRead;
			return bytesRead === bytes.length && createHash("sha256").update(bytes).digest("hex") === fingerprint.digest;
		}
		async function readCountedAnchor(handle: FileHandle, offset: number): Promise<Buffer> {
			const bytes = await readAnchor(handle, offset);
			if (isPi) sourceBytesExamined += bytes.length;
			return bytes;
		}
		const lookup = locator
			? await locator.locate({
					projectId: "",
					taskId: "",
					providerSessionId: input.hint.providerSessionId,
					hint: input.hint,
					deadlineAt,
				})
			: null;
		const source = isPi
			? await openPiProgressSource(input.hint).catch(() => null)
			: lookup?.status === "available"
				? lookup.source
				: null;
		if (!source) {
			if (requestedGeneration === generation) {
				state.latest = null;
				if (isPi && state.fileIdentity !== null) state.invalidated = true;
			}
			return { text: null, hasMore: false, sourceBytesExamined };
		}
		try {
			const before = await source.fileHandle.stat();
			const fileIdentity = identityOf(source.canonicalPath, before);
			if (!Number.isSafeInteger(before.size) || before.size < 0 || Date.now() > deadlineAt)
				return { text: null, hasMore: false, sourceBytesExamined };
			const anchor = await readCountedAnchor(source.fileHandle, next.offset <= before.size ? next.offset : 0);
			const previewRecordMatches = await matchesPreviewRecord(source.fileHandle, next.previewRecord);
			const headerRecordMatches = await matchesPreviewRecord(source.fileHandle, next.piHeaderRecord);
			const changed =
				(next.fileIdentity !== null || next.invalidated) &&
				(next.invalidated ||
					!previewRecordMatches ||
					!headerRecordMatches ||
					(next.piSnapshot !== null &&
						(before.size < next.piSnapshot.size ||
							(before.size === next.piSnapshot.size &&
								(before.mtimeMs !== next.piSnapshot.mtimeMs || before.ctimeMs !== next.piSnapshot.ctimeMs)))) ||
					next.fileIdentity !== fileIdentity ||
					next.offset > before.size ||
					(next.anchor.length > 0 && !next.anchor.equals(anchor)));
			if (next.fileIdentity === null || changed) {
				next = initialState();
				next.fileIdentity = fileIdentity;
				// A replacement cannot resurrect existing text from the displaced source.
				next.offset = changed ? before.size : Math.max(0, before.size - limits.maxSourceBytes);
				next.discardUntilNewline = next.offset > 0;
				if (changed && before.size > 0) {
					const last = await readCountedAnchor(source.fileHandle, before.size);
					next.discardUntilNewline = last.at(-1) !== 10;
				}
			}
			if (source.providerId === "pi") {
				const head = await readJsonlHeadRecord({
					fileHandle: source.fileHandle,
					fileSize: before.size,
					maxBytes: piHeaderBudget,
					maxRawRecordBytes: piHeaderBudget,
					chunkBytes: Math.min(1024, Math.max(1, piHeaderBudget)),
					deadlineAt,
				});
				sourceBytesExamined += head.bytesExamined;
				if (
					head.kind !== "parsed" ||
					!input.launchPath ||
					!(await isValidPiProgressHeader(head.value, source.providerSessionId, input.launchPath))
				) {
					next.latest = null;
					if (requestedGeneration === generation) state = next;
					return { text: null, hasMore: false, sourceBytesExamined };
				}
				next.piHeaderRecord = {
					byteOffset: 0,
					byteLength: head.bytes.length,
					digest: createHash("sha256").update(head.bytes).digest("hex"),
				};
				next.headerValidated = true;
			}
			if (source.providerId === "codex" && !next.headerValidated && before.size > 0) {
				const head = await readJsonlHeadRecord({
					fileHandle: source.fileHandle,
					fileSize: before.size,
					maxBytes: Math.min(64 * 1024, limits.maxSourceBytes - sourceBytesExamined),
					maxRawRecordBytes: 64 * 1024,
					chunkBytes: 4 * 1024,
					deadlineAt,
				});
				sourceBytesExamined += head.bytesExamined;
				if (head.kind === "incomplete" || head.kind === "empty") {
					if (requestedGeneration === generation) state = next;
					return { text: null, hasMore: false, sourceBytesExamined };
				}
				const header = head.kind === "parsed" ? parseCodexSessionHeader(head.value) : null;
				if (header?.status !== "valid" || header.providerSessionId !== source.providerSessionId) {
					next.latest = null;
					next.blocked = true;
				} else next.headerValidated = true;
			}
			const scan = await readIncrementalJsonl({
				fileHandle: source.fileHandle,
				fileSize: before.size,
				position: next,
				// Reserve a bounded recheck of whichever assistant record survives this batch.
				maxBytes: Math.max(
					0,
					limits.maxSourceBytes - sourceBytesExamined - maxPreviewRecordBytes - piHeaderBudget - (isPi ? 256 : 0),
				),
				maxRecords: limits.maxRecords,
				maxRawRecordBytes: limits.maxRawRecordBytes,
				chunkBytes: limits.chunkBytes,
				deadlineAt,
				onRecord: (line) => {
					if (line.kind === "opaque") {
						next.latest = null;
						next.claudeLeafId = null;
						if (isPi) {
							// Oversized or malformed entries have unknown ancestry. The
							// next persisted assistant can still be the new active leaf.
							clearPiPreview();
							next.piLeafId = null;
						}
						return;
					}
					if (source.providerId === "pi") {
						// The separately validated header is metadata, not a tree entry.
						if (line.byteOffset === 0) return;
						const entry = parsePiProgressEntry(line.value);
						if (!entry || next.piRecentIds.has(entry.id) || entry.id === next.piPreviewEntryId) {
							clearPiPreview();
							next.piLeafId = entry?.id ?? null;
							return;
						}
						next.piRecentIds.add(entry.id);
						if (next.piRecentIds.size > MAX_PI_RECENT_IDS) {
							const oldest = next.piRecentIds.values().next().value;
							if (oldest !== undefined) next.piRecentIds.delete(oldest);
						}
						if (
							entry.boundary ||
							(next.piLeafId && entry.parentId !== next.piLeafId) ||
							entry.invalidatesPreview ||
							(entry.editedEntryId !== null && entry.editedEntryId === next.piPreviewEntryId)
						)
							clearPiPreview();
						// Pi's last persisted entry is the saved active leaf. A branch
						// change retires old text, not newly appended assistant replies.
						next.piLeafId = entry.id;
						// message.timestamp is streaming-start time, potentially before
						// native Running admission. Entry time identifies the saved reply.
						if (next.blocked || entry.recordedAt < epochSince || entry.text === null) return;
						if (line.bytes.length > maxPreviewRecordBytes) {
							clearPiPreview();
							return;
						}
						next.piPreviewEntryId = entry.id;
						next.latest = normalizeConversationText(entry.text, 2 * 1024)?.text.slice(0, 500) || null;
						next.previewRecord = {
							byteOffset: line.byteOffset,
							byteLength: line.bytes.length,
							digest: createHash("sha256").update(line.bytes).digest("hex"),
						};
						return;
					}
					// The history parser's user-turn set is backwards-scan state. A fresh
					// parser per record reuses its shapes without retaining that history.
					const record =
						source.providerId === "codex"
							? createCodexHistoryRecordParser()(line.value)
							: parseClaudeHistoryRecord(line.value);
					const timestamp = isJsonObject(line.value) ? readString(line.value, "timestamp") : null;
					const recordedAt = timestamp ? Date.parse(timestamp) : Number.NaN;
					if (record.lineage?.isSidechain) return;
					if (
						(record.providerSessionId && record.providerSessionId !== source.providerSessionId) ||
						(source.providerId === "claude" && record.item.kind === "message" && !record.providerSessionId)
					) {
						next.latest = null;
						next.blocked = true;
						return;
					}
					if (record.item.kind === "malformed" || record.item.kind === "rollback") {
						// A known prior-epoch rollback cannot retire messages from this epoch.
						if (record.item.kind === "rollback" && Number.isFinite(recordedAt) && recordedAt < epochSince) return;
						next.latest = null;
						// Without retained turns, rollback reconstruction cannot prove a survivor.
						if (record.item.kind === "rollback") next.blocked = true;
						return;
					}
					if (record.lineage) {
						if (
							next.claudeLeafId &&
							record.lineage.parentFieldPresent &&
							record.lineage.parentNativeId !== next.claudeLeafId
						)
							next.latest = null;
						next.claudeLeafId = record.lineage.nativeId;
					}
					if (
						next.blocked ||
						record.item.kind !== "message" ||
						record.item.role !== "assistant" ||
						!Number.isFinite(recordedAt) ||
						recordedAt < epochSince
					)
						return;
					if (line.bytes.length > maxPreviewRecordBytes) {
						next.latest = null;
						return;
					}
					next.latest = normalizeConversationText(record.item.text, 2 * 1024)?.text.slice(0, 500) || null;
					next.previewRecord = {
						byteOffset: line.byteOffset,
						byteLength: line.bytes.length,
						digest: createHash("sha256").update(line.bytes).digest("hex"),
					};
				},
			});
			sourceBytesExamined += scan.bytesExamined;
			next = { ...next, ...scan.position };
			const validation = await validateOpenedContainedRegularFile({
				canonicalRoot: source.canonicalRoot,
				canonicalPath: source.canonicalPath,
				pathStat: before,
				fileHandle: source.fileHandle,
			});
			const finalPreviewRecordMatches = await matchesPreviewRecord(source.fileHandle, next.previewRecord);
			const finalHeaderRecordMatches = await matchesPreviewRecord(source.fileHandle, next.piHeaderRecord);
			const exactPiPathMatches =
				!isPi || areFileSystemPathsEqual(await realpath(input.hint.sourcePath), source.canonicalPath);
			if (
				scan.sourceChanged ||
				!finalPreviewRecordMatches ||
				!finalHeaderRecordMatches ||
				!exactPiPathMatches ||
				validation.status !== "valid" ||
				validation.fileStat.size < next.offset ||
				(validation.fileStat.size === before.size &&
					(validation.fileStat.mtimeMs !== before.mtimeMs ||
						(isPi && validation.fileStat.ctimeMs !== before.ctimeMs)))
			) {
				// Preserve the old identity so the next read skips a changed snapshot.
				if (requestedGeneration === generation) {
					state.latest = null;
					state.fileIdentity ??= fileIdentity;
					state.invalidated = true;
				}
				return { text: null, hasMore: true, sourceBytesExamined };
			}
			next.anchor = await readCountedAnchor(source.fileHandle, next.offset);
			if (requestedGeneration !== generation) return { text: null, hasMore: true, sourceBytesExamined };
			if (isPi)
				next.piSnapshot = {
					size: validation.fileStat.size,
					mtimeMs: validation.fileStat.mtimeMs,
					ctimeMs: validation.fileStat.ctimeMs,
				};
			state = next;
			return {
				text: isPi && Date.now() > deadlineAt ? null : next.latest,
				hasMore: next.offset < validation.fileStat.size,
				sourceBytesExamined,
			};
		} catch {
			if (requestedGeneration === generation) {
				state.latest = null;
				if (isPi) state.invalidated = true;
			}
			return { text: null, hasMore: false, sourceBytesExamined };
		} finally {
			await source.fileHandle.close().catch(() => undefined);
		}
	}

	return {
		read,
		pause,
		beginEpoch(value): void {
			pause();
			since = value;
			if (isPi && !Number.isFinite(value)) state.blocked = true;
		},
	};
}
