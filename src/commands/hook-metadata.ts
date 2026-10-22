import { randomUUID } from "node:crypto";

import type { RuntimeHookEvent, RuntimeHookIngestRequest, RuntimeHookMetadata } from "../core/api/task-session.js";
import { CODEX_SESSION_START_SOURCES, type CodexSessionStartSource } from "../core/codex-session-start-sources.js";

const HOOK_METADATA_TEXT_MAX_LENGTH = 500;

// Validates against the same canonical tuple `runtimeCodexSessionStartSourceSchema`
// (core/api/task-session.ts) builds its zod enum from, without importing zod or the
// broader task-session schema surface into this hot CLI path, which is shared by the
// lightweight hook entry (dist/hooks.js).
const CODEX_SESSION_START_SOURCE_SET: ReadonlySet<string> = new Set(CODEX_SESSION_START_SOURCES);

function parseCodexSessionStartSource(value: unknown): CodexSessionStartSource | null {
	return typeof value === "string" && CODEX_SESSION_START_SOURCE_SET.has(value)
		? (value as CodexSessionStartSource)
		: null;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function compactHookMetadataText(value: string): string {
	const normalized = normalizeWhitespace(value);
	return normalized.length > HOOK_METADATA_TEXT_MAX_LENGTH
		? `${normalized.slice(0, HOOK_METADATA_TEXT_MAX_LENGTH)}\u2026`
		: normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") {
		return null;
	}
	const normalized = normalizeWhitespace(value);
	return normalized.length > 0 ? normalized : null;
}

function readTrimmedStringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function readNestedString(record: Record<string, unknown>, path: string[]): string | null {
	let current: unknown = record;
	for (const key of path) {
		const candidate = asRecord(current);
		if (!candidate || !(key in candidate)) {
			return null;
		}
		current = candidate[key];
	}
	if (typeof current !== "string") {
		return null;
	}
	const normalized = normalizeWhitespace(current);
	return normalized.length > 0 ? normalized : null;
}

function readHookEventName(payload: Record<string, unknown> | null): string | null {
	return payload
		? (readStringField(payload, "hook_event_name") ??
				readStringField(payload, "hookEventName") ??
				readStringField(payload, "hookName"))
		: null;
}

// Background shells (dev servers, watchers) and monitors may never finish, so they must not hold a
// finished turn in progress. They can still wake the same prompt later, so such a Stop reaches review
// without retiring the prompt; a woken turn's next tool or Stop hook is then accepted.
const CLAUDE_UNBOUNDED_BACKGROUND_TASK_TYPES = new Set(["shell", "monitor"]);

type ClaudeStopBackgroundWork = "none" | "unbounded" | "pending";

function isClaudeBackgroundTaskUnbounded(task: unknown): boolean {
	const record = asRecord(task);
	const type = record ? readStringField(record, "type")?.toLowerCase() : null;
	return Boolean(type && CLAUDE_UNBOUNDED_BACKGROUND_TASK_TYPES.has(type));
}

function classifyClaudeStopBackgroundWork(
	payload: Record<string, unknown> | null,
	source: string | null | undefined,
	hookEventName = readHookEventName(payload),
): ClaudeStopBackgroundWork {
	if (source?.trim().toLowerCase() !== "claude" || hookEventName?.toLowerCase() !== "stop" || !payload) {
		return "none";
	}
	const backgroundTasks = Array.isArray(payload.background_tasks) ? payload.background_tasks : [];
	if (
		backgroundTasks.some((task) => !isClaudeBackgroundTaskUnbounded(task)) ||
		(Array.isArray(payload.session_crons) && payload.session_crons.length > 0)
	) {
		return "pending";
	}
	return backgroundTasks.length > 0 ? "unbounded" : "none";
}

export function resolveHookEventFromPayload(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	source: string | null | undefined,
): RuntimeHookEvent {
	return event === "to_review" && classifyClaudeStopBackgroundWork(payload, source) === "pending" ? "activity" : event;
}

export function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

export interface HookCommandMetadataOptionValues {
	source?: string;
	activityText?: string;
	toolName?: string;
	toolInputSummary?: string;
	finalMessage?: string;
	hookEventName?: string;
	notificationType?: string;
	sessionId?: string;
	sessionInstanceId?: string;
	turnId?: string;
	promptId?: string;
	toolUseId?: string;
	elicitationId?: string;
	providerAgentId?: string;
	transcriptPath?: string;
	metadataBase64?: string;
}

export function parseMetadataFromOptions(options: HookCommandMetadataOptionValues): RuntimeHookMetadata {
	const metadata: RuntimeHookMetadata = {};
	const activityText = options.activityText;
	const toolName = options.toolName;
	const toolInputSummary = options.toolInputSummary;
	const finalMessage = options.finalMessage;
	const hookEventName = options.hookEventName;
	const notificationType = options.notificationType;
	const source = options.source;
	const sessionId = options.sessionId;
	const sessionInstanceId = options.sessionInstanceId;
	const turnId = options.turnId;
	const promptId = options.promptId;
	const toolUseId = options.toolUseId;
	const elicitationId = options.elicitationId;
	const providerAgentId = options.providerAgentId;
	const transcriptPath = options.transcriptPath;

	if (activityText) {
		metadata.activityText = compactHookMetadataText(activityText);
	}
	if (toolName) {
		metadata.toolName = normalizeWhitespace(toolName);
	}
	if (toolInputSummary) {
		metadata.toolInputSummary = compactHookMetadataText(toolInputSummary);
	}
	if (finalMessage) {
		metadata.finalMessage = compactHookMetadataText(finalMessage);
	}
	if (hookEventName) {
		metadata.hookEventName = normalizeWhitespace(hookEventName);
	}
	if (notificationType) {
		metadata.notificationType = normalizeWhitespace(notificationType);
	}
	if (source) {
		metadata.source = normalizeWhitespace(source);
	}
	if (sessionId) {
		metadata.sessionId = normalizeWhitespace(sessionId);
	}
	if (sessionInstanceId) {
		metadata.sessionInstanceId = normalizeWhitespace(sessionInstanceId);
	}
	if (turnId) {
		metadata.turnId = normalizeWhitespace(turnId);
	}
	if (promptId) {
		metadata.promptId = normalizeWhitespace(promptId);
	}
	if (toolUseId) {
		metadata.toolUseId = normalizeWhitespace(toolUseId);
	}
	if (elicitationId) {
		metadata.elicitationId = normalizeWhitespace(elicitationId);
	}
	if (providerAgentId) {
		metadata.providerAgentId = normalizeWhitespace(providerAgentId);
	}
	if (transcriptPath) {
		metadata.transcriptPath = transcriptPath.trim();
	}

	return metadata;
}

export function parseMetadataFromBase64(encoded: string | undefined): Record<string, unknown> | null {
	if (!encoded) {
		return null;
	}
	try {
		return asRecord(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
	} catch {
		return null;
	}
}

function extractToolInput(payload: Record<string, unknown>): Record<string, unknown> | null {
	const direct = asRecord(payload.tool_input);
	if (direct) {
		return direct;
	}
	const directCamel = asRecord(payload.toolInput);
	if (directCamel) {
		return directCamel;
	}
	const preTool = asRecord(payload.preToolUse);
	const preParams = preTool ? asRecord(preTool.parameters) : null;
	if (preParams) {
		return preParams;
	}
	const preInput = preTool ? asRecord(preTool.input) : null;
	if (preInput) {
		return preInput;
	}
	const postTool = asRecord(payload.postToolUse);
	const postParams = postTool ? asRecord(postTool.parameters) : null;
	if (postParams) {
		return postParams;
	}
	const postInput = postTool ? asRecord(postTool.input) : null;
	if (postInput) {
		return postInput;
	}
	const output = asRecord(payload.output);
	const outputArgs = output ? asRecord(output.args) : null;
	return outputArgs;
}

function describeToolOperation(toolName: string | null, toolInput: Record<string, unknown> | null): string | null {
	if (!toolName || !toolInput) {
		return null;
	}

	const command =
		readStringField(toolInput, "command") ??
		readStringField(toolInput, "cmd") ??
		readStringField(toolInput, "query") ??
		readStringField(toolInput, "description");
	if (command) {
		return `${toolName}: ${command}`;
	}

	const filePath =
		readStringField(toolInput, "file_path") ??
		readStringField(toolInput, "filePath") ??
		readStringField(toolInput, "path");
	if (filePath) {
		return `${toolName}: ${filePath}`;
	}

	return toolName;
}

function inferActivityText(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	toolName: string | null,
	finalMessage: string | null,
	notificationType: string | null,
	waitingForBackgroundWork: boolean,
): string | null {
	const hookEventName = readHookEventName(payload);
	const normalizedHookEvent = hookEventName?.toLowerCase() ?? "";
	const normalizedToolName = toolName?.toLowerCase() ?? "";
	const codexType = payload ? readStringField(payload, "type") : null;
	const normalizedCodexType = codexType?.toLowerCase() ?? "";
	const toolInput = payload ? extractToolInput(payload) : null;
	const toolOperation = describeToolOperation(toolName, toolInput);

	if (normalizedCodexType === "task_started") {
		return "Working on task";
	}
	if (normalizedCodexType === "exec_command_begin") {
		return "Running command";
	}
	if (normalizedCodexType.endsWith("_approval_request")) {
		return "Waiting for approval";
	}

	if (normalizedHookEvent === "pretooluse" || normalizedHookEvent === "beforetool") {
		if (normalizedToolName === "askuserquestion") {
			return "Needs input";
		}
		if (normalizedToolName === "exitplanmode") {
			return "Waiting for plan approval";
		}
		return toolOperation ? `Using ${toolOperation}` : "Using tool";
	}
	if (normalizedHookEvent === "posttooluse" || normalizedHookEvent === "aftertool") {
		return toolOperation ? `Completed ${toolOperation}` : "Completed tool";
	}
	if (normalizedHookEvent === "posttoolusefailure") {
		const error = payload ? readStringField(payload, "error") : null;
		if (toolOperation && error) {
			return `Failed ${toolOperation}: ${error}`;
		}
		if (toolOperation) {
			return `Failed ${toolOperation}`;
		}
		return error ? `Tool failed: ${error}` : "Tool failed";
	}
	if (normalizedHookEvent === "permissionrequest") {
		return "Waiting for approval";
	}
	if (normalizedHookEvent === "permissiondenied") {
		return "Permission denied";
	}
	if (normalizedHookEvent === "userpromptsubmit" || normalizedHookEvent === "beforeagent") {
		return "Resumed after user input";
	}
	if (normalizedHookEvent === "subagentstart") {
		const agentType = payload ? readStringField(payload, "agent_type") : null;
		return agentType ? `Subagent started: ${agentType}` : "Subagent started";
	}
	if (
		normalizedHookEvent === "stop" ||
		normalizedHookEvent === "subagentstop" ||
		normalizedHookEvent === "afteragent"
	) {
		if (normalizedHookEvent === "stop" && waitingForBackgroundWork) {
			return "Waiting for background work";
		}
		return finalMessage ? `Final: ${finalMessage}` : null;
	}
	if (normalizedHookEvent === "stopfailure") {
		const reason = payload ? readStringField(payload, "reason") : null;
		const error = payload ? readStringField(payload, "error") : null;
		const errorType = payload ? readStringField(payload, "error_type") : null;
		const errorMessage = payload ? readStringField(payload, "error_message") : null;
		return `Claude turn failed${
			reason || error || errorType || errorMessage ? `: ${reason ?? error ?? errorType ?? errorMessage}` : ""
		}`;
	}
	if (normalizedHookEvent === "precompact") {
		return "Compacting context";
	}
	if (normalizedHookEvent === "postcompact") {
		return "Compacted context";
	}
	if (normalizedHookEvent === "elicitation") {
		return "Needs input";
	}
	if (normalizedHookEvent === "elicitationresult") {
		return "Resumed after user input";
	}
	if (normalizedHookEvent === "taskcomplete") {
		return finalMessage ? `Final: ${finalMessage}` : null;
	}

	if (notificationType === "permission_prompt" || notificationType === "permission.asked") {
		return "Waiting for approval";
	}
	if (notificationType === "agent_needs_input") {
		return "Needs input";
	}
	if (notificationType === "elicitation_dialog") {
		return "Needs input";
	}
	if (notificationType === "elicitation_complete" || notificationType === "elicitation_response") {
		return "Resumed after user input";
	}
	if (notificationType === "agent_completed") {
		return "Background agent completed";
	}
	if (notificationType === "user_attention") {
		return null;
	}

	if (event === "to_review") {
		return null;
	}
	if (event === "to_in_progress") {
		return "Agent active";
	}
	return null;
}

function isClaudeMainStopSummary(input: {
	source: string | null;
	hookEventName: string | null;
	finalMessage: string | null;
}): boolean {
	return (
		input.source?.toLowerCase() === "claude" &&
		input.hookEventName?.toLowerCase() === "stop" &&
		!!input.finalMessage?.trim()
	);
}

export function inferHookSourceFromPayload(payload: Record<string, unknown> | null): string | null {
	const transcriptPath = payload
		? (readTrimmedStringField(payload, "transcript_path") ?? readTrimmedStringField(payload, "transcriptPath"))
		: null;
	const normalizedTranscriptPath = transcriptPath?.replaceAll("\\", "/").toLowerCase() ?? null;
	if (normalizedTranscriptPath?.includes("/.claude/")) {
		return "claude";
	}
	if (payload && readStringField(payload, "type") === "agent-turn-complete") {
		return "codex";
	}
	return null;
}

export function normalizeHookMetadata(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	flagMetadata: RuntimeHookMetadata,
): RuntimeHookMetadata | undefined {
	const hookEventName = readHookEventName(payload);
	const toolName = payload
		? (readStringField(payload, "tool_name") ??
			readStringField(payload, "toolName") ??
			readNestedString(payload, ["preToolUse", "tool"]) ??
			readNestedString(payload, ["preToolUse", "toolName"]) ??
			readNestedString(payload, ["postToolUse", "tool"]) ??
			readNestedString(payload, ["postToolUse", "toolName"]) ??
			readNestedString(payload, ["input", "tool"]) ??
			readNestedString(payload, ["input", "toolName"]))
		: null;
	const notificationType = payload
		? (readStringField(payload, "notification_type") ??
			readStringField(payload, "notificationType") ??
			readNestedString(payload, ["event", "type"]) ??
			readNestedString(payload, ["notification", "event"]))
		: null;
	const inferredSource = inferHookSourceFromPayload(payload);
	const source = flagMetadata.source ?? inferredSource ?? null;
	const sessionStartSource =
		source?.trim().toLowerCase() === "codex" && hookEventName?.toLowerCase() === "sessionstart"
			? parseCodexSessionStartSource(payload?.source)
			: null;
	const backgroundWork = classifyClaudeStopBackgroundWork(payload, source, hookEventName);
	const waitingForBackgroundWork = backgroundWork === "pending";
	const extractedFinalMessage = payload
		? (readStringField(payload, "last_assistant_message") ??
			readStringField(payload, "lastAssistantMessage") ??
			readStringField(payload, "last-assistant-message") ??
			readNestedString(payload, ["taskComplete", "taskMetadata", "result"]) ??
			readNestedString(payload, ["taskComplete", "result"]))
		: null;
	const finalMessage =
		!waitingForBackgroundWork && extractedFinalMessage ? compactHookMetadataText(extractedFinalMessage) : null;
	const transcriptPath = payload
		? (readTrimmedStringField(payload, "transcript_path") ?? readTrimmedStringField(payload, "transcriptPath"))
		: null;
	const turnId = payload
		? (readTrimmedStringField(payload, "turn_id") ?? readTrimmedStringField(payload, "turnId"))
		: null;
	const promptId = payload
		? (readTrimmedStringField(payload, "prompt_id") ?? readTrimmedStringField(payload, "promptId"))
		: null;
	const toolUseId = payload
		? (readTrimmedStringField(payload, "tool_use_id") ?? readTrimmedStringField(payload, "toolUseId"))
		: null;
	const elicitationId = payload
		? (readTrimmedStringField(payload, "elicitation_id") ?? readTrimmedStringField(payload, "elicitationId"))
		: null;
	const providerAgentId = payload
		? (readTrimmedStringField(payload, "agent_id") ?? readTrimmedStringField(payload, "agentId"))
		: null;

	const toolInput = payload ? extractToolInput(payload) : null;
	const toolInputSummary = describeToolOperation(toolName, toolInput);
	const conversationSummaryText = waitingForBackgroundWork
		? null
		: isClaudeMainStopSummary({ source, hookEventName, finalMessage })
			? finalMessage
			: payload
				? (readStringField(payload, "conversation_summary_text") ??
					readStringField(payload, "conversationSummaryText") ??
					readNestedString(payload, ["taskComplete", "taskMetadata", "summary"]))
				: null;

	const activityText = inferActivityText(
		event,
		payload,
		toolName,
		finalMessage,
		notificationType,
		waitingForBackgroundWork,
	);
	const merged: RuntimeHookMetadata = {
		source,
		hookEventName: flagMetadata.hookEventName ?? hookEventName ?? null,
		toolName: flagMetadata.toolName ?? toolName ?? null,
		toolInputSummary:
			flagMetadata.toolInputSummary ?? (toolInputSummary ? compactHookMetadataText(toolInputSummary) : null),
		notificationType: flagMetadata.notificationType ?? notificationType ?? null,
		finalMessage: waitingForBackgroundWork
			? null
			: (flagMetadata.finalMessage ?? (finalMessage ? compactHookMetadataText(finalMessage) : null)),
		activityText: flagMetadata.activityText ?? (activityText ? compactHookMetadataText(activityText) : null),
		sessionId: flagMetadata.sessionId ?? null,
		sessionInstanceId: flagMetadata.sessionInstanceId ?? null,
		turnId: flagMetadata.turnId ?? turnId ?? null,
		promptId: flagMetadata.promptId ?? promptId ?? null,
		toolUseId: flagMetadata.toolUseId ?? toolUseId ?? null,
		elicitationId: flagMetadata.elicitationId ?? elicitationId ?? null,
		providerAgentId: flagMetadata.providerAgentId ?? providerAgentId ?? null,
		transcriptPath: flagMetadata.transcriptPath ?? transcriptPath ?? null,
		...(sessionStartSource ? { sessionStartSource } : undefined),
		conversationSummaryText: waitingForBackgroundWork
			? null
			: (flagMetadata.conversationSummaryText ??
				(conversationSummaryText ? compactHookMetadataText(conversationSummaryText) : null)),
		...(backgroundWork === "unbounded" ? { unboundedBackgroundWorkPending: true } : undefined),
	};

	const hasValue = Object.values(merged).some((value) => typeof value === "string" && value.trim().length > 0);
	if (!hasValue) {
		return undefined;
	}

	return merged;
}

export function readPayloadStringField(payload: Record<string, unknown>, key: string): string | null {
	return readStringField(payload, key);
}

/**
 * Single source of truth for the `hooks ingest|notify` metadata flag set, shared by
 * commander's `.option()` registration (`commands/hooks.ts`) and the lightweight hook
 * entry's manual argv parser (`hook-entry.ts`), which cannot depend on commander.
 */
export const HOOK_METADATA_FLAG_SPECS: ReadonlyArray<{
	flag: string;
	key: keyof HookCommandMetadataOptionValues;
	description: string;
}> = [
	{ flag: "--source", key: "source", description: "Hook source." },
	{ flag: "--activity-text", key: "activityText", description: "Activity summary text." },
	{ flag: "--tool-name", key: "toolName", description: "Tool name." },
	{ flag: "--tool-input-summary", key: "toolInputSummary", description: "Tool input summary." },
	{ flag: "--final-message", key: "finalMessage", description: "Final message." },
	{ flag: "--hook-event-name", key: "hookEventName", description: "Original hook event name." },
	{ flag: "--notification-type", key: "notificationType", description: "Notification type." },
	{ flag: "--session-id", key: "sessionId", description: "Resumable agent session id." },
	{ flag: "--session-instance-id", key: "sessionInstanceId", description: "Quarterdeck task-process instance id." },
	{ flag: "--turn-id", key: "turnId", description: "Agent turn id." },
	{ flag: "--prompt-id", key: "promptId", description: "Provider prompt id." },
	{ flag: "--tool-use-id", key: "toolUseId", description: "Agent tool-use id." },
	{ flag: "--elicitation-id", key: "elicitationId", description: "Provider elicitation id." },
	{ flag: "--provider-agent-id", key: "providerAgentId", description: "Provider background-agent id." },
	{ flag: "--transcript-path", key: "transcriptPath", description: "Agent transcript JSONL path." },
	{ flag: "--metadata-base64", key: "metadataBase64", description: "Base64-encoded JSON metadata payload." },
];

/** The launch-scoped identity a native hook invocation reports for. */
export interface HookIngestIdentity {
	taskId: string;
	projectId: string;
	sessionInstanceId?: string | null;
}

/**
 * Builds the `hooks.ingest` request for one native hook invocation. The hook
 * CLI and the runtime's HTTP hook endpoint share this, so a provider payload
 * carries identical meaning on every delivery transport.
 */
export function buildHookIngestRequest(input: {
	event: RuntimeHookEvent;
	identity: HookIngestIdentity;
	flagMetadata: RuntimeHookMetadata;
	payload: Record<string, unknown> | null;
}): RuntimeHookIngestRequest {
	const { identity, flagMetadata, payload } = input;
	const sessionInstanceId = identity.sessionInstanceId?.trim() || null;
	const payloadSessionId = payload
		? (readStringField(payload, "session_id") ?? readStringField(payload, "sessionId"))
		: null;
	const metadataContext = {
		...flagMetadata,
		sessionId: flagMetadata.sessionId ?? payloadSessionId ?? null,
		sessionInstanceId: flagMetadata.sessionInstanceId ?? sessionInstanceId,
	};
	const event = resolveHookEventFromPayload(
		input.event,
		payload,
		metadataContext.source ?? inferHookSourceFromPayload(payload),
	);
	return {
		taskId: identity.taskId,
		projectId: identity.projectId,
		event,
		metadata: normalizeHookMetadata(event, payload, metadataContext),
		delivery: sessionInstanceId ? { id: randomUUID(), occurredAt: Date.now() } : undefined,
	};
}

export function appendMetadataFlags(args: string[], metadata?: RuntimeHookMetadata): string[] {
	if (!metadata) {
		return args;
	}
	if (metadata.source) {
		args.push("--source", metadata.source);
	}
	if (metadata.activityText) {
		args.push("--activity-text", metadata.activityText);
	}
	if (metadata.toolName) {
		args.push("--tool-name", metadata.toolName);
	}
	if (metadata.toolInputSummary) {
		args.push("--tool-input-summary", metadata.toolInputSummary);
	}
	if (metadata.finalMessage) {
		args.push("--final-message", metadata.finalMessage);
	}
	if (metadata.hookEventName) {
		args.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata.notificationType) {
		args.push("--notification-type", metadata.notificationType);
	}
	if (metadata.sessionId) {
		args.push("--session-id", metadata.sessionId);
	}
	if (metadata.sessionInstanceId) {
		args.push("--session-instance-id", metadata.sessionInstanceId);
	}
	if (metadata.turnId) {
		args.push("--turn-id", metadata.turnId);
	}
	if (metadata.promptId) {
		args.push("--prompt-id", metadata.promptId);
	}
	if (metadata.toolUseId) {
		args.push("--tool-use-id", metadata.toolUseId);
	}
	if (metadata.elicitationId) {
		args.push("--elicitation-id", metadata.elicitationId);
	}
	if (metadata.providerAgentId) {
		args.push("--provider-agent-id", metadata.providerAgentId);
	}
	if (metadata.transcriptPath) {
		args.push("--transcript-path", metadata.transcriptPath);
	}
	return args;
}
