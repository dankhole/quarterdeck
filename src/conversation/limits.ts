export const CONVERSATION_READ_DEFAULT_MESSAGE_COUNT = 10;
export const CONVERSATION_READ_MAX_MESSAGE_COUNT = 24;

export interface ConversationReadLimits {
	defaultMessageCount: number;
	maxMessageCount: number;
	maxBoundaryCount: number;
	maxTotalEntryCount: number;
	maxSourceBytes: number;
	maxRecords: number;
	maxRawRecordBytes: number;
	maxMessageBytes: number;
	maxResponseBytes: number;
	maxDiagnosticBytes: number;
	maxLookupEntries: number;
	deadlineMs: number;
	tailChunkBytes: number;
}

export const DEFAULT_CONVERSATION_READ_LIMITS: Readonly<ConversationReadLimits> = Object.freeze({
	defaultMessageCount: CONVERSATION_READ_DEFAULT_MESSAGE_COUNT,
	maxMessageCount: CONVERSATION_READ_MAX_MESSAGE_COUNT,
	maxBoundaryCount: 4,
	maxTotalEntryCount: 28,
	maxSourceBytes: 4 * 1024 * 1024,
	maxRecords: 4_096,
	maxRawRecordBytes: 1024 * 1024,
	maxMessageBytes: 32 * 1024,
	maxResponseBytes: 128 * 1024,
	maxDiagnosticBytes: 2 * 1024,
	maxLookupEntries: 10_000,
	deadlineMs: 2_000,
	tailChunkBytes: 64 * 1024,
});
