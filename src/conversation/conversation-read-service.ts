import { createTaggedLogger } from "../core/index.js";
import {
	type ConversationBoundaryEntry,
	type ConversationEntry,
	type ConversationReadDiagnostics,
	type ConversationReadInvalidSourceReason,
	type ConversationReadIssue,
	type ConversationReadRequest,
	type ConversationReadResult,
	type ConversationReadSessionMismatchReason,
	type ConversationReadSourceMissingReason,
	type ConversationReadUnavailableReason,
	type ConversationReadUnsupportedReason,
	conversationReadRequestSchema,
} from "./contracts.js";
import { type ConversationReadLimits, DEFAULT_CONVERSATION_READ_LIMITS } from "./limits.js";
import { createConversationProviderAdapters } from "./provider-adapters.js";
import { type ConversationHistoryRoots, resolveDefaultConversationHistoryRoots } from "./provider-source-locator.js";
import { createHistoryGapId } from "./stable-id.js";
import type {
	ConversationProviderAdapterRegistry,
	ConversationProviderId,
	ConversationProviderReadResult,
	ConversationReadAccounting,
	ConversationSourceHintReader,
	ConversationSourceLookup,
	ConversationTaskSessionIdentity,
	ConversationTaskSessionResolver,
	ParsedProviderConversationEntry,
} from "./types.js";

const log = createTaggedLogger("conversation-read");

export interface ConversationReadService {
	readRecent(input: ConversationReadRequest): Promise<ConversationReadResult>;
}

export interface CreateConversationReadServiceInput {
	sessions: ConversationTaskSessionResolver;
	hints?: ConversationSourceHintReader;
	adapters?: ConversationProviderAdapterRegistry;
	roots?: ConversationHistoryRoots;
	limits?: Readonly<ConversationReadLimits>;
}

function emptyAccounting(): ConversationReadAccounting {
	return { sourceBytesExamined: 0, recordsExamined: 0, lookupEntriesExamined: 0 };
}

function createDiagnostics(input: {
	accounting: ConversationReadAccounting;
	entries: readonly ConversationEntry[];
	durationMs: number;
	issues: readonly ConversationReadIssue[];
	limits: Readonly<ConversationReadLimits>;
}): ConversationReadDiagnostics {
	const issues = [...new Set(input.issues)];
	const diagnostics: ConversationReadDiagnostics = {
		sourceBytesExamined: input.accounting.sourceBytesExamined,
		recordsExamined: input.accounting.recordsExamined,
		lookupEntriesExamined: input.accounting.lookupEntriesExamined,
		returnedMessages: input.entries.filter((entry) => entry.type === "message").length,
		returnedBoundaries: input.entries.filter((entry) => entry.type === "boundary").length,
		durationMs: Math.max(0, Math.round(input.durationMs)),
		issues,
	};
	while (Buffer.byteLength(JSON.stringify(diagnostics), "utf8") > input.limits.maxDiagnosticBytes) {
		if (issues.length === 0) {
			break;
		}
		issues.pop();
	}
	return diagnostics;
}

type EmptyResultClassification =
	| { status: "invalid_source"; reason: ConversationReadInvalidSourceReason }
	| { status: "session_mismatch"; reason: ConversationReadSessionMismatchReason }
	| { status: "source_missing"; reason: ConversationReadSourceMissingReason }
	| { status: "unavailable"; reason: ConversationReadUnavailableReason }
	| { status: "unsupported"; reason: ConversationReadUnsupportedReason };

function createEmptyResult(
	input: EmptyResultClassification & {
		requestedMessages: number;
		accounting: ConversationReadAccounting;
		durationMs: number;
		limits: Readonly<ConversationReadLimits>;
	},
): ConversationReadResult {
	const diagnostics = createDiagnostics({
		accounting: input.accounting,
		entries: [],
		durationMs: input.durationMs,
		issues: [],
		limits: input.limits,
	});
	const common = {
		entries: [] as const,
		hasOlder: false,
		incomplete: true,
		requestedMessages: input.requestedMessages,
		diagnostics,
	};
	if (input.status === "invalid_source") {
		return { ...common, status: "invalid_source", reason: input.reason };
	}
	if (input.status === "session_mismatch") {
		return { ...common, status: "session_mismatch", reason: input.reason };
	}
	if (input.status === "source_missing") {
		return { ...common, status: "source_missing", reason: input.reason };
	}
	if (input.status === "unsupported") {
		return { ...common, status: "unsupported", reason: input.reason };
	}
	return { ...common, status: "unavailable", reason: input.reason };
}

function addIssue(issues: ConversationReadIssue[], issue: ConversationReadIssue): void {
	if (!issues.includes(issue)) {
		issues.push(issue);
	}
}

function selectBoundedEntries(input: {
	providerEntries: readonly ParsedProviderConversationEntry[];
	hasGap: boolean;
	providerSessionId: string;
	limits: Readonly<ConversationReadLimits>;
}): ConversationEntry[] {
	const messageEntries = input.providerEntries.filter((candidate) => candidate.entry.type === "message");
	const boundaryLimit = input.limits.maxBoundaryCount - (input.hasGap ? 1 : 0);
	const retainedBoundaries = input.providerEntries
		.filter((candidate) => candidate.entry.type === "boundary")
		.slice(-Math.max(0, boundaryLimit));
	const retained = [...messageEntries, ...retainedBoundaries]
		.sort((left, right) => left.byteOffset - right.byteOffset)
		.map((candidate) => candidate.entry);
	if (input.hasGap) {
		const oldestEntryId = retained[0]?.id ?? null;
		const gap: ConversationBoundaryEntry = {
			type: "boundary",
			kind: "history_gap",
			id: createHistoryGapId(oldestEntryId, input.providerSessionId),
		};
		retained.unshift(gap);
	}
	return retained.slice(-input.limits.maxTotalEntryCount);
}

function ensureGap(entries: ConversationEntry[], providerSessionId: string): void {
	const existingGap = entries.find((entry) => entry.type === "boundary" && entry.kind === "history_gap");
	if (existingGap) {
		return;
	}
	entries.unshift({
		type: "boundary",
		kind: "history_gap",
		id: createHistoryGapId(entries[0]?.id ?? null, providerSessionId),
	});
}

function finalizeAvailableResult(input: {
	provider: ConversationProviderReadResult;
	providerSessionId: string;
	requestedMessages: number;
	accounting: ConversationReadAccounting;
	durationMs: number;
	limits: Readonly<ConversationReadLimits>;
}): ConversationReadResult {
	const issues = [...input.provider.issues];
	let status: "available" | "degraded" = input.provider.status === "degraded" ? "degraded" : "available";
	let reason = input.provider.status === "degraded" ? input.provider.reason : null;
	let hasOlder = input.provider.hasOlder;
	let incomplete = input.provider.incomplete;
	const entries = selectBoundedEntries({
		providerEntries: input.provider.entries,
		hasGap: hasOlder || incomplete,
		providerSessionId: input.providerSessionId,
		limits: input.limits,
	});

	const buildResult = (): ConversationReadResult => {
		const diagnostics = createDiagnostics({
			accounting: input.accounting,
			entries,
			durationMs: input.durationMs,
			issues,
			limits: input.limits,
		});
		if (status === "degraded") {
			return {
				status,
				reason: (reason as ConversationReadIssue | null) ?? "response_truncated",
				entries,
				hasOlder,
				incomplete,
				requestedMessages: input.requestedMessages,
				diagnostics,
			};
		}
		return {
			status,
			reason: null,
			entries,
			hasOlder,
			incomplete,
			requestedMessages: input.requestedMessages,
			diagnostics,
		};
	};

	let result = buildResult();
	while (Buffer.byteLength(JSON.stringify(result), "utf8") > input.limits.maxResponseBytes) {
		const oldestMessageIndex = entries.findIndex((entry) => entry.type === "message");
		if (oldestMessageIndex >= 0) {
			entries.splice(oldestMessageIndex, 1);
		} else {
			const removableBoundaryIndex = entries.findIndex(
				(entry) => entry.type === "boundary" && entry.kind !== "history_gap",
			);
			if (removableBoundaryIndex < 0) {
				break;
			}
			entries.splice(removableBoundaryIndex, 1);
		}
		status = "degraded";
		reason = "response_truncated";
		hasOlder = true;
		incomplete = true;
		addIssue(issues, "response_truncated");
		ensureGap(entries, input.providerSessionId);
		result = buildResult();
	}
	return result;
}

function isSupportedProvider(agentId: string): agentId is ConversationProviderId {
	return agentId === "claude" || agentId === "codex";
}

export function createConversationReadService(input: CreateConversationReadServiceInput): ConversationReadService {
	const limits = input.limits ?? DEFAULT_CONVERSATION_READ_LIMITS;
	const adapters =
		input.adapters ??
		createConversationProviderAdapters({
			roots: input.roots ?? resolveDefaultConversationHistoryRoots(),
			limits,
		});
	return {
		readRecent: async (rawInput) => {
			const startedAt = Date.now();
			const parsedRequest = conversationReadRequestSchema.safeParse(rawInput);
			if (!parsedRequest.success) {
				return createEmptyResult({
					status: "unavailable",
					reason: "invalid_request",
					requestedMessages: limits.defaultMessageCount,
					accounting: emptyAccounting(),
					durationMs: Date.now() - startedAt,
					limits,
				});
			}
			const request = parsedRequest.data;
			const deadlineAt = startedAt + limits.deadlineMs;
			let taskSession: ConversationTaskSessionIdentity | null;
			try {
				taskSession = await input.sessions.resolveTaskSession(request.projectId, request.taskId);
			} catch {
				return createEmptyResult({
					status: "unavailable",
					reason: "source_read_failed",
					requestedMessages: request.maxMessages,
					accounting: emptyAccounting(),
					durationMs: Date.now() - startedAt,
					limits,
				});
			}
			if (!taskSession) {
				return createEmptyResult({
					status: "unavailable",
					reason: "task_session_not_found",
					requestedMessages: request.maxMessages,
					accounting: emptyAccounting(),
					durationMs: Date.now() - startedAt,
					limits,
				});
			}
			if (taskSession.projectId !== request.projectId || taskSession.taskId !== request.taskId) {
				return createEmptyResult({
					status: "unavailable",
					reason: "task_session_not_found",
					requestedMessages: request.maxMessages,
					accounting: emptyAccounting(),
					durationMs: Date.now() - startedAt,
					limits,
				});
			}
			if (!taskSession.agentId) {
				return createEmptyResult({
					status: "unavailable",
					reason: "agent_not_selected",
					requestedMessages: request.maxMessages,
					accounting: emptyAccounting(),
					durationMs: Date.now() - startedAt,
					limits,
				});
			}
			if (!isSupportedProvider(taskSession.agentId)) {
				return createEmptyResult({
					status: "unsupported",
					reason: "provider_not_supported",
					requestedMessages: request.maxMessages,
					accounting: emptyAccounting(),
					durationMs: Date.now() - startedAt,
					limits,
				});
			}
			const providerSessionId = taskSession.providerSessionId?.trim() ?? "";
			if (!providerSessionId) {
				return createEmptyResult({
					status: "unavailable",
					reason: "session_identity_unavailable",
					requestedMessages: request.maxMessages,
					accounting: emptyAccounting(),
					durationMs: Date.now() - startedAt,
					limits,
				});
			}
			const adapter = adapters[taskSession.agentId];
			if (!adapter) {
				return createEmptyResult({
					status: "unsupported",
					reason: "provider_not_supported",
					requestedMessages: request.maxMessages,
					accounting: emptyAccounting(),
					durationMs: Date.now() - startedAt,
					limits,
				});
			}

			const hint = input.hints?.getHint(request.projectId, request.taskId, providerSessionId) ?? null;
			let lookup: ConversationSourceLookup;
			try {
				lookup = await adapter.locateSource({
					projectId: request.projectId,
					taskId: request.taskId,
					providerSessionId,
					deadlineAt,
					hint,
				});
			} catch {
				return createEmptyResult({
					status: "unavailable",
					reason: "source_read_failed",
					requestedMessages: request.maxMessages,
					accounting: emptyAccounting(),
					durationMs: Date.now() - startedAt,
					limits,
				});
			}
			if (lookup.status !== "available") {
				const common = {
					requestedMessages: request.maxMessages,
					accounting: lookup.accounting,
					durationMs: Date.now() - startedAt,
					limits,
				};
				if (lookup.status === "invalid_source") {
					return createEmptyResult({ ...common, status: lookup.status, reason: lookup.reason });
				}
				if (lookup.status === "source_missing") {
					return createEmptyResult({ ...common, status: lookup.status, reason: lookup.reason });
				}
				return createEmptyResult({ ...common, status: lookup.status, reason: lookup.reason });
			}

			let providerResult: ConversationProviderReadResult | null = null;
			try {
				providerResult = await adapter.readRecent({
					source: lookup.source,
					maxMessages: request.maxMessages,
					deadlineAt,
					remainingSourceBytes: limits.maxSourceBytes,
					remainingRecords: limits.maxRecords,
				});
			} catch {
				providerResult = null;
			} finally {
				await lookup.source.fileHandle.close().catch(() => undefined);
			}
			if (!providerResult) {
				return createEmptyResult({
					status: "unavailable",
					reason: "source_read_failed",
					requestedMessages: request.maxMessages,
					accounting: lookup.accounting,
					durationMs: Date.now() - startedAt,
					limits,
				});
			}
			const accounting = {
				sourceBytesExamined: providerResult.accounting.sourceBytesExamined,
				recordsExamined: providerResult.accounting.recordsExamined,
				lookupEntriesExamined: lookup.accounting.lookupEntriesExamined,
			};
			if (providerResult.status !== "available" && providerResult.status !== "degraded") {
				const common = {
					requestedMessages: request.maxMessages,
					accounting,
					durationMs: Date.now() - startedAt,
					limits,
				};
				let result: ConversationReadResult;
				if (providerResult.status === "session_mismatch") {
					result = createEmptyResult({ ...common, status: providerResult.status, reason: providerResult.reason });
				} else if (providerResult.status === "unsupported") {
					result = createEmptyResult({ ...common, status: providerResult.status, reason: providerResult.reason });
				} else {
					result = createEmptyResult({ ...common, status: providerResult.status, reason: providerResult.reason });
				}
				log.debug("conversation read completed", {
					projectId: request.projectId,
					taskId: request.taskId,
					provider: taskSession.agentId,
					status: result.status,
					reason: result.reason,
					...result.diagnostics,
				});
				return result;
			}

			const result = finalizeAvailableResult({
				provider: providerResult,
				providerSessionId,
				requestedMessages: request.maxMessages,
				accounting,
				durationMs: Date.now() - startedAt,
				limits,
			});
			log.debug("conversation read completed", {
				projectId: request.projectId,
				taskId: request.taskId,
				provider: taskSession.agentId,
				status: result.status,
				reason: result.reason,
				...result.diagnostics,
			});
			return result;
		},
	};
}
