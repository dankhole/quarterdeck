import { z } from "zod";

import { CONVERSATION_READ_DEFAULT_MESSAGE_COUNT, CONVERSATION_READ_MAX_MESSAGE_COUNT } from "./limits.js";

export const conversationReadRequestSchema = z
	.object({
		projectId: z.string().trim().min(1).max(512),
		taskId: z.string().trim().min(1).max(512),
		maxMessages: z
			.number()
			.int()
			.positive()
			.max(CONVERSATION_READ_MAX_MESSAGE_COUNT)
			.default(CONVERSATION_READ_DEFAULT_MESSAGE_COUNT),
	})
	.strict();

export type ConversationReadRequest = z.input<typeof conversationReadRequestSchema>;
export type ParsedConversationReadRequest = z.output<typeof conversationReadRequestSchema>;

export type ConversationMessageRole = "user" | "assistant";

export interface ConversationMessageEntry {
	type: "message";
	id: string;
	role: ConversationMessageRole;
	text: string;
}

export type ConversationBoundaryKind =
	| "started"
	| "resumed"
	| "restarted"
	| "compacted"
	| "interrupted"
	| "history_gap";

export interface ConversationBoundaryEntry {
	type: "boundary";
	id: string;
	kind: ConversationBoundaryKind;
}

export type ConversationEntry = ConversationMessageEntry | ConversationBoundaryEntry;

export type ConversationReadIssue =
	| "deadline_exceeded"
	| "history_compacted"
	| "history_reconstruction_incomplete"
	| "incomplete_tail"
	| "invalid_unicode"
	| "malformed_record"
	| "message_truncated"
	| "oversized_record"
	| "record_limit"
	| "response_truncated"
	| "source_byte_limit"
	| "source_changed";

export interface ConversationReadDiagnostics {
	sourceBytesExamined: number;
	recordsExamined: number;
	lookupEntriesExamined: number;
	returnedMessages: number;
	returnedBoundaries: number;
	durationMs: number;
	issues: readonly ConversationReadIssue[];
}

export type ConversationReadUnavailableReason =
	| "agent_not_selected"
	| "deadline_exceeded"
	| "invalid_request"
	| "session_identity_unavailable"
	| "source_lookup_limit"
	| "source_read_failed"
	| "source_root_unavailable"
	| "task_session_not_found";

export type ConversationReadUnsupportedReason = "format_unsupported" | "provider_not_supported";
export type ConversationReadSourceMissingReason = "source_not_found";
export type ConversationReadSessionMismatchReason = "source_identity_mismatch";
export type ConversationReadInvalidSourceReason =
	| "source_not_regular_file"
	| "source_outside_allowed_roots"
	| "source_path_invalid";
export type ConversationReadDegradedReason = ConversationReadIssue;

interface ConversationReadResultBase {
	entries: readonly ConversationEntry[];
	hasOlder: boolean;
	incomplete: boolean;
	requestedMessages: number;
	diagnostics: ConversationReadDiagnostics;
}

export interface ConversationReadAvailableResult extends ConversationReadResultBase {
	status: "available";
	reason: null;
}

export interface ConversationReadDegradedResult extends ConversationReadResultBase {
	status: "degraded";
	reason: ConversationReadDegradedReason;
}

export interface ConversationReadUnavailableResult extends ConversationReadResultBase {
	status: "unavailable";
	reason: ConversationReadUnavailableReason;
	entries: readonly [];
}

export interface ConversationReadUnsupportedResult extends ConversationReadResultBase {
	status: "unsupported";
	reason: ConversationReadUnsupportedReason;
	entries: readonly [];
}

export interface ConversationReadSourceMissingResult extends ConversationReadResultBase {
	status: "source_missing";
	reason: ConversationReadSourceMissingReason;
	entries: readonly [];
}

export interface ConversationReadSessionMismatchResult extends ConversationReadResultBase {
	status: "session_mismatch";
	reason: ConversationReadSessionMismatchReason;
	entries: readonly [];
}

export interface ConversationReadInvalidSourceResult extends ConversationReadResultBase {
	status: "invalid_source";
	reason: ConversationReadInvalidSourceReason;
	entries: readonly [];
}

export type ConversationReadResult =
	| ConversationReadAvailableResult
	| ConversationReadDegradedResult
	| ConversationReadUnavailableResult
	| ConversationReadUnsupportedResult
	| ConversationReadSourceMissingResult
	| ConversationReadSessionMismatchResult
	| ConversationReadInvalidSourceResult;
