import { scanJsonlTail } from "./bounded-jsonl-tail.js";
import type { ConversationEntry, ConversationReadIssue } from "./contracts.js";
import type { ConversationReadLimits } from "./limits.js";
import { createNativeConversationEntryId, createSourceCoordinateConversationEntryId } from "./stable-id.js";
import { normalizeConversationText } from "./text-normalization.js";
import type {
	ConversationProviderReadResult,
	ConversationReadRecentInput,
	ParsedProviderConversationEntry,
	ParsedProviderRecord,
	ParsedProviderRecordAtOffset,
	ProviderHistoryReconstructionResult,
} from "./types.js";

interface ProjectedCandidate extends ParsedProviderConversationEntry {
	issues: readonly ConversationReadIssue[];
}

function addIssue(issues: ConversationReadIssue[], issue: ConversationReadIssue): void {
	if (!issues.includes(issue)) {
		issues.push(issue);
	}
}

function issueFromRecordKind(
	kind: "incomplete" | "invalid_unicode" | "malformed" | "oversized",
): ConversationReadIssue {
	if (kind === "incomplete") return "incomplete_tail";
	if (kind === "invalid_unicode") return "invalid_unicode";
	if (kind === "oversized") return "oversized_record";
	return "malformed_record";
}

function createBoundaryEntry(input: {
	source: ConversationReadRecentInput["source"];
	record: ParsedProviderRecordAtOffset;
}): ConversationEntry | null {
	const item = input.record.record.item;
	if (item.kind !== "boundary") {
		return null;
	}
	const id = item.nativeId
		? createNativeConversationEntryId({
				providerId: input.source.providerId,
				sessionId: input.source.providerSessionId,
				nativeId: item.nativeId,
				kind: item.boundary,
			})
		: createSourceCoordinateConversationEntryId({
				providerId: input.source.providerId,
				sessionId: input.source.providerSessionId,
				byteOffset: input.record.byteOffset,
				contentIndex: item.contentIndex,
				kind: item.boundary,
			});
	return { type: "boundary", id, kind: item.boundary };
}

function createMessageCandidate(input: {
	source: ConversationReadRecentInput["source"];
	record: ParsedProviderRecordAtOffset;
	limits: Readonly<ConversationReadLimits>;
}): ProjectedCandidate | null {
	const item = input.record.record.item;
	if (item.kind !== "message") {
		return null;
	}
	const normalized = normalizeConversationText(item.text, input.limits.maxMessageBytes);
	if (!normalized) {
		return null;
	}
	const id = item.nativeId
		? createNativeConversationEntryId({
				providerId: input.source.providerId,
				sessionId: input.source.providerSessionId,
				nativeId: item.nativeId,
				kind: item.role,
			})
		: createSourceCoordinateConversationEntryId({
				providerId: input.source.providerId,
				sessionId: input.source.providerSessionId,
				byteOffset: input.record.byteOffset,
				contentIndex: item.contentIndex,
				kind: item.role,
			});
	const candidateIssues: ConversationReadIssue[] = [];
	if (normalized.unsafeCharactersReplaced) candidateIssues.push("invalid_unicode");
	if (normalized.truncated) candidateIssues.push("message_truncated");
	return {
		byteOffset: input.record.byteOffset,
		entry: { type: "message", id, role: item.role, text: normalized.text },
		issues: candidateIssues,
	};
}

export async function readProviderConversationTail(input: {
	read: ConversationReadRecentInput;
	limits: Readonly<ConversationReadLimits>;
	parseRecord(value: unknown): ParsedProviderRecord;
	reconstructRecords?: (records: readonly ParsedProviderRecordAtOffset[]) => ProviderHistoryReconstructionResult;
	requireMessageSessionIdentity?: boolean;
	initialAccounting?: { sourceBytesExamined: number; recordsExamined: number; lookupEntriesExamined: number };
}): Promise<ConversationProviderReadResult> {
	const source = input.read.source;
	const issues: ConversationReadIssue[] = [];
	const scannedNewestFirst: ParsedProviderRecordAtOffset[] = [];
	let hasOlder = false;
	let incomplete = false;
	let fidelityAffected = false;
	let degradedReason: ConversationReadIssue | null = null;
	let stoppedAtCompaction = false;
	let stoppedAfterSufficientTail = false;
	let reconstructionCandidateCount = 0;
	let nextReconstructionCheckAt = input.read.maxMessages + 1;
	let opaqueBarrier: ConversationReadIssue | null = null;
	const markFidelityAffected = (issue: ConversationReadIssue): void => {
		fidelityAffected = true;
		degradedReason ??= issue;
	};

	try {
		const scan = await scanJsonlTail({
			fileHandle: source.fileHandle,
			fileSize: source.fileSize,
			maxBytes: input.read.remainingSourceBytes,
			maxRecords: input.read.remainingRecords,
			maxRawRecordBytes: input.limits.maxRawRecordBytes,
			chunkBytes: input.limits.tailChunkBytes,
			deadlineAt: input.read.deadlineAt,
			onRecord: (record) => {
				if (record.kind !== "parsed") {
					const issue = issueFromRecordKind(record.kind);
					addIssue(issues, issue);
					incomplete = true;
					hasOlder = true;
					opaqueBarrier ??= issue;
					return false;
				}

				const parsed = input.parseRecord(record.value);
				if (parsed.item.kind === "malformed") {
					addIssue(issues, "malformed_record");
					incomplete = true;
					hasOlder = true;
					opaqueBarrier ??= "malformed_record";
					return false;
				}
				scannedNewestFirst.push({ record: parsed, byteOffset: record.byteOffset });
				if (parsed.item.kind === "boundary" && parsed.item.boundary === "compacted") {
					addIssue(issues, "history_compacted");
					incomplete = true;
					hasOlder = true;
					stoppedAtCompaction = parsed.item.stopsOlderScan;
					return !parsed.item.stopsOlderScan;
				}
				if (parsed.item.kind === "message" || parsed.item.kind === "rollback" || parsed.lineage) {
					reconstructionCandidateCount += 1;
					if (reconstructionCandidateCount < nextReconstructionCheckAt) return true;
					const chronological = [...scannedNewestFirst].reverse();
					const reconstructed = input.reconstructRecords?.(chronological) ?? {
						records: chronological,
						incomplete: false,
						incompleteReason: null,
					};
					const reconstructedMessageIds = new Set(
						reconstructed.records.flatMap((candidate) => {
							const message = createMessageCandidate({ source, record: candidate, limits: input.limits });
							return message ? [message.entry.id] : [];
						}),
					);
					const safeOlderFrontier =
						!reconstructed.incomplete || reconstructed.incompleteReason === "missing_ancestor";
					if (reconstructedMessageIds.size > input.read.maxMessages && safeOlderFrontier) {
						// One extra meaningful message is enough to prove older history.
						// Stop before the bounded reader turns a recent-tail request into
						// a full-file parse merely to rediscover still older content.
						stoppedAfterSufficientTail = true;
						return false;
					}
					nextReconstructionCheckAt =
						reconstructionCandidateCount +
						Math.max(
							1,
							input.read.maxMessages + 1 - reconstructedMessageIds.size,
							Math.ceil(reconstructionCandidateCount / 2),
						);
				}
				return true;
			},
		});

		const initialAccounting = input.initialAccounting ?? {
			sourceBytesExamined: 0,
			recordsExamined: 0,
			lookupEntriesExamined: 0,
		};
		const accounting = {
			sourceBytesExamined: initialAccounting.sourceBytesExamined + scan.bytesExamined,
			recordsExamined: initialAccounting.recordsExamined + scan.recordsExamined,
			lookupEntriesExamined: initialAccounting.lookupEntriesExamined,
		};

		const chronological = [...scannedNewestFirst].reverse();
		const reconstructed = input.reconstructRecords?.(chronological) ?? {
			records: chronological,
			incomplete: false,
			incompleteReason: null,
		};
		const identityMismatch = reconstructed.records.some(({ record }) => {
			if (record.providerSessionId && record.providerSessionId.trim() !== source.providerSessionId) {
				return true;
			}
			return input.requireMessageSessionIdentity && record.item.kind === "message" && !record.providerSessionId;
		});
		if (identityMismatch) {
			return {
				status: "session_mismatch",
				reason: "source_identity_mismatch",
				entries: [],
				hasOlder: false,
				incomplete: true,
				issues,
				accounting,
			};
		}

		if (reconstructed.incomplete && !stoppedAfterSufficientTail) {
			addIssue(issues, "history_reconstruction_incomplete");
			incomplete = true;
			hasOlder = true;
			markFidelityAffected("history_reconstruction_incomplete");
		}
		if (stoppedAfterSufficientTail) {
			hasOlder = true;
		}

		const selectedNewestFirst: ProjectedCandidate[] = [];
		const returnedMessageIds = new Set<string>();
		const returnedBoundaryIds = new Set<string>();
		let messageCount = 0;
		let crossedMessageLimit = false;
		for (const record of [...reconstructed.records].reverse()) {
			const message = createMessageCandidate({ source, record, limits: input.limits });
			if (message) {
				if (returnedMessageIds.has(message.entry.id)) {
					continue;
				}
				returnedMessageIds.add(message.entry.id);
				if (messageCount >= input.read.maxMessages) {
					hasOlder = true;
					crossedMessageLimit = true;
					continue;
				}
				messageCount += 1;
				for (const issue of message.issues) {
					addIssue(issues, issue);
					incomplete = true;
					markFidelityAffected(issue);
				}
				selectedNewestFirst.push(message);
				continue;
			}
			if (crossedMessageLimit) {
				continue;
			}
			const boundary = createBoundaryEntry({ source, record });
			if (!boundary || returnedBoundaryIds.has(boundary.id)) {
				continue;
			}
			returnedBoundaryIds.add(boundary.id);
			selectedNewestFirst.push({ entry: boundary, byteOffset: record.byteOffset, issues: [] });
		}

		if (opaqueBarrier && messageCount < input.read.maxMessages) {
			markFidelityAffected(opaqueBarrier);
		}
		if (scan.sourceChanged) {
			addIssue(issues, "source_changed");
			incomplete = true;
			markFidelityAffected("source_changed");
		}
		if (scan.limitReached === "bytes") {
			addIssue(issues, "source_byte_limit");
			incomplete = true;
			hasOlder = true;
			if (messageCount < input.read.maxMessages) markFidelityAffected("source_byte_limit");
		}
		if (scan.limitReached === "records") {
			addIssue(issues, "record_limit");
			incomplete = true;
			hasOlder = true;
			if (messageCount < input.read.maxMessages) markFidelityAffected("record_limit");
		}
		if (scan.deadlineReached && !scan.stoppedByConsumer) {
			addIssue(issues, "deadline_exceeded");
			incomplete = true;
			hasOlder = true;
			if (messageCount < input.read.maxMessages) {
				markFidelityAffected("deadline_exceeded");
			}
			if (messageCount === 0) {
				return {
					status: "unavailable",
					reason: "deadline_exceeded",
					entries: [],
					hasOlder: false,
					incomplete: true,
					issues,
					accounting,
				};
			}
		}

		const sortedEntries = selectedNewestFirst.reverse();
		if (stoppedAtCompaction) {
			hasOlder = true;
		}
		if (fidelityAffected) {
			return {
				status: "degraded",
				reason: degradedReason ?? "malformed_record",
				entries: sortedEntries,
				hasOlder,
				incomplete,
				issues,
				accounting,
			};
		}
		return {
			status: "available",
			reason: null,
			entries: sortedEntries,
			hasOlder,
			incomplete,
			issues,
			accounting,
		};
	} catch {
		return {
			status: "unavailable",
			reason: "source_read_failed",
			entries: [],
			hasOlder: false,
			incomplete: true,
			issues,
			accounting: input.initialAccounting ?? {
				sourceBytesExamined: 0,
				recordsExamined: 0,
				lookupEntriesExamined: 0,
			},
		};
	}
}
