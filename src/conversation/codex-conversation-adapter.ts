import { readJsonlHeadRecord } from "./bounded-jsonl-head.js";
import { createCodexHistoryRecordParser, parseCodexSessionHeader } from "./codex-history-parser.js";
import { reconstructCodexHistory } from "./codex-history-reconstruction.js";
import type { ConversationReadLimits } from "./limits.js";
import { ProviderConversationSourceLocator } from "./provider-source-locator.js";
import { readProviderConversationTail } from "./provider-tail-reader.js";
import type {
	ConversationProviderAdapter,
	ConversationProviderReadResult,
	ConversationReadRecentInput,
	ConversationSourceLocatorInput,
	ConversationSourceLookup,
} from "./types.js";

export class CodexConversationAdapter implements ConversationProviderAdapter {
	readonly providerId = "codex" as const;
	private readonly locator: ProviderConversationSourceLocator;

	constructor(
		roots: readonly string[],
		private readonly limits: Readonly<ConversationReadLimits>,
	) {
		this.locator = new ProviderConversationSourceLocator(this.providerId, roots, limits);
	}

	async locateSource(input: ConversationSourceLocatorInput): Promise<ConversationSourceLookup> {
		return await this.locator.locate(input);
	}

	async readRecent(input: ConversationReadRecentInput): Promise<ConversationProviderReadResult> {
		const head = await readJsonlHeadRecord({
			fileHandle: input.source.fileHandle,
			fileSize: input.source.fileSize,
			maxBytes: input.remainingSourceBytes,
			maxRawRecordBytes: this.limits.maxRawRecordBytes,
			chunkBytes: this.limits.tailChunkBytes,
			deadlineAt: input.deadlineAt,
		});
		const headAccounting = {
			sourceBytesExamined: head.bytesExamined,
			recordsExamined: head.recordsExamined,
			lookupEntriesExamined: 0,
		};
		if (Date.now() > input.deadlineAt) {
			return {
				status: "unavailable",
				reason: "deadline_exceeded",
				entries: [],
				hasOlder: false,
				incomplete: true,
				issues: ["deadline_exceeded"],
				accounting: headAccounting,
			};
		}
		if (head.kind !== "empty" && head.kind !== "parsed") {
			return {
				status: "unsupported",
				reason: "format_unsupported",
				entries: [],
				hasOlder: false,
				incomplete: true,
				issues: [],
				accounting: headAccounting,
			};
		}
		if (head.kind === "parsed") {
			const parsedHead = parseCodexSessionHeader(head.value);
			if (parsedHead.status !== "valid" || !parsedHead.providerSessionId) {
				return {
					status: "unsupported",
					reason: "format_unsupported",
					entries: [],
					hasOlder: false,
					incomplete: true,
					issues: [],
					accounting: headAccounting,
				};
			}
			if (parsedHead.providerSessionId !== input.source.providerSessionId) {
				return {
					status: "session_mismatch",
					reason: "source_identity_mismatch",
					entries: [],
					hasOlder: false,
					incomplete: true,
					issues: [],
					accounting: headAccounting,
				};
			}
		}

		return await readProviderConversationTail({
			read: {
				...input,
				remainingSourceBytes: Math.max(0, input.remainingSourceBytes - head.bytesExamined),
				remainingRecords: Math.max(0, input.remainingRecords - head.recordsExamined),
			},
			limits: this.limits,
			parseRecord: createCodexHistoryRecordParser(),
			reconstructRecords: reconstructCodexHistory,
			initialAccounting: headAccounting,
		});
	}
}
