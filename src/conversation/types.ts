import type { FileHandle } from "node:fs/promises";

import type { RuntimeAgentId } from "../core/index.js";
import type {
	ConversationBoundaryKind,
	ConversationEntry,
	ConversationMessageRole,
	ConversationReadIssue,
} from "./contracts.js";

export type ConversationProviderId = "claude" | "codex";

export interface ConversationTaskSessionIdentity {
	projectId: string;
	taskId: string;
	agentId: RuntimeAgentId | null;
	providerSessionId: string | null;
}

export interface ConversationTaskSessionResolver {
	resolveTaskSession(projectId: string, taskId: string): Promise<ConversationTaskSessionIdentity | null>;
}

export interface ConversationSourceHint {
	providerId: ConversationProviderId;
	providerSessionId: string;
	sourcePath: string;
}

export interface ConversationSourceHintReader {
	getHint(projectId: string, taskId: string, providerSessionId: string): ConversationSourceHint | null;
}

export interface ValidatedConversationSource {
	providerId: ConversationProviderId;
	providerSessionId: string;
	canonicalPath: string;
	canonicalRoot: string;
	fileHandle: FileHandle;
	fileSize: number;
}

export interface ConversationReadAccounting {
	sourceBytesExamined: number;
	recordsExamined: number;
	lookupEntriesExamined: number;
}

export type ConversationSourceLookup =
	| {
			status: "available";
			source: ValidatedConversationSource;
			accounting: ConversationReadAccounting;
	  }
	| {
			status: "unavailable";
			reason: "deadline_exceeded" | "source_lookup_limit" | "source_root_unavailable";
			accounting: ConversationReadAccounting;
	  }
	| {
			status: "source_missing";
			reason: "source_not_found";
			accounting: ConversationReadAccounting;
	  }
	| {
			status: "invalid_source";
			reason: "source_not_regular_file" | "source_outside_allowed_roots" | "source_path_invalid";
			accounting: ConversationReadAccounting;
	  };

export interface ParsedProviderConversationEntry {
	entry: ConversationEntry;
	byteOffset: number;
}

export type ParsedProviderItem =
	| {
			kind: "message";
			role: ConversationMessageRole;
			text: string;
			nativeId: string | null;
			contentIndex: number;
	  }
	| {
			kind: "boundary";
			boundary: Exclude<ConversationBoundaryKind, "history_gap">;
			nativeId: string | null;
			contentIndex: number;
			stopsOlderScan: boolean;
	  }
	| { kind: "rollback"; numTurns: number }
	| { kind: "ignore" }
	| { kind: "malformed" };

export interface ProviderRecordLineage {
	nativeId: string;
	parentNativeId: string | null;
	parentFieldPresent: boolean;
	isSidechain: boolean;
}

export interface ParsedProviderRecord {
	recognized: boolean;
	providerSessionId: string | null;
	item: ParsedProviderItem;
	lineage?: ProviderRecordLineage;
}

export interface ParsedProviderRecordAtOffset {
	record: ParsedProviderRecord;
	byteOffset: number;
}

export interface ProviderHistoryReconstructionResult {
	records: readonly ParsedProviderRecordAtOffset[];
	incomplete: boolean;
	incompleteReason: "missing_ancestor" | "cycle" | "rollback_underflow" | null;
}

interface ConversationProviderReadResultBase {
	entries: readonly ParsedProviderConversationEntry[];
	hasOlder: boolean;
	incomplete: boolean;
	issues: readonly ConversationReadIssue[];
	accounting: ConversationReadAccounting;
}

export type ConversationProviderReadResult =
	| (ConversationProviderReadResultBase & { status: "available"; reason: null })
	| (ConversationProviderReadResultBase & { status: "degraded"; reason: ConversationReadIssue })
	| (ConversationProviderReadResultBase & {
			status: "session_mismatch";
			reason: "source_identity_mismatch";
	  })
	| (ConversationProviderReadResultBase & { status: "unsupported"; reason: "format_unsupported" })
	| (ConversationProviderReadResultBase & {
			status: "unavailable";
			reason: "deadline_exceeded" | "source_read_failed";
	  });

export interface ConversationReadRecentInput {
	source: ValidatedConversationSource;
	maxMessages: number;
	deadlineAt: number;
	remainingSourceBytes: number;
	remainingRecords: number;
}

export interface ConversationSourceLocatorInput {
	projectId: string;
	taskId: string;
	providerSessionId: string;
	deadlineAt: number;
	hint: ConversationSourceHint | null;
}

export interface ConversationProviderAdapter {
	providerId: ConversationProviderId;
	locateSource(input: ConversationSourceLocatorInput): Promise<ConversationSourceLookup>;
	readRecent(input: ConversationReadRecentInput): Promise<ConversationProviderReadResult>;
}

export type ConversationProviderAdapterRegistry = Readonly<
	Partial<Record<ConversationProviderId, ConversationProviderAdapter>>
>;
