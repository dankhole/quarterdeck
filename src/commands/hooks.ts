import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";

import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../core/api-contract.js";
import { buildKanbanCommandParts } from "../core/kanban-command.js";
import { buildKanbanRuntimeUrl } from "../core/runtime-endpoint.js";
import { parseHookRuntimeContextFromEnv } from "../terminal/hook-runtime-context.js";
import type { RuntimeAppRouter } from "../trpc/app-router.js";

const VALID_EVENTS = new Set<RuntimeHookEvent>(["to_review", "to_in_progress", "activity"]);
const CODEX_LOG_WAIT_ATTEMPTS = 200;
const CODEX_LOG_WAIT_DELAY_MS = 50;
const CODEX_LOG_POLL_INTERVAL_MS = 200;
const MAX_ACTIVITY_TEXT_LENGTH = 200;
const MAX_FINAL_MESSAGE_LENGTH = 600;

interface HooksIngestArgs {
	event: RuntimeHookEvent;
	taskId: string;
	workspaceId: string;
	metadata?: Partial<RuntimeTaskHookActivity>;
}

interface CodexWrapperArgs {
	realBinary: string;
	agentArgs: string[];
}

interface CodexWatcherState {
	lastTurnId: string;
	lastApprovalId: string;
	lastExecCallId: string;
	lastActivityFingerprint: string;
	approvalFallbackSeq: number;
	offset: number;
	remainder: string;
}

interface CodexEventPayload {
	type?: unknown;
	turn_id?: unknown;
	id?: unknown;
	approval_id?: unknown;
	call_id?: unknown;
	last_agent_message?: unknown;
	message?: unknown;
	command?: unknown;
	item?: unknown;
}

interface CodexSessionLogLine {
	dir?: unknown;
	kind?: unknown;
	msg?: unknown;
	payload?: unknown;
	turn_id?: unknown;
	id?: unknown;
	approval_id?: unknown;
	call_id?: unknown;
}

function formatError(error: unknown): string {
	if (error instanceof TRPCClientError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeoutHandle: NodeJS.Timeout | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function parseEventArg(argv: string[]): RuntimeHookEvent {
	let event: string | null = null;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--event" && next) {
			event = next;
			i += 1;
			continue;
		}
		if (arg.startsWith("--event=")) {
			event = arg.slice("--event=".length);
		}
	}
	if (!event) {
		throw new Error("Missing required flag: --event");
	}
	if (!VALID_EVENTS.has(event as RuntimeHookEvent)) {
		throw new Error(`Invalid event "${event}". Must be one of: ${[...VALID_EVENTS].join(", ")}`);
	}
	return event as RuntimeHookEvent;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function parseArgValue(argv: string[], key: string): string | null {
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === key) {
			const next = argv[i + 1];
			if (!next) {
				return null;
			}
			return next;
		}
		if (arg.startsWith(`${key}=`)) {
			return arg.slice(`${key}=`.length);
		}
	}
	return null;
}

function parseMetadataFromFlags(argv: string[]): Partial<RuntimeTaskHookActivity> {
	const metadata: Partial<RuntimeTaskHookActivity> = {};
	const activityText = parseArgValue(argv, "--activity-text");
	const toolName = parseArgValue(argv, "--tool-name");
	const finalMessage = parseArgValue(argv, "--final-message");
	const hookEventName = parseArgValue(argv, "--hook-event-name");
	const notificationType = parseArgValue(argv, "--notification-type");
	const source = parseArgValue(argv, "--source");

	if (activityText) {
		metadata.activityText = truncateText(normalizeWhitespace(activityText), MAX_ACTIVITY_TEXT_LENGTH);
	}
	if (toolName) {
		metadata.toolName = truncateText(normalizeWhitespace(toolName), 120);
	}
	if (finalMessage) {
		metadata.finalMessage = truncateText(normalizeWhitespace(finalMessage), MAX_FINAL_MESSAGE_LENGTH);
	}
	if (hookEventName) {
		metadata.hookEventName = truncateText(normalizeWhitespace(hookEventName), 120);
	}
	if (notificationType) {
		metadata.notificationType = truncateText(normalizeWhitespace(notificationType), 120);
	}
	if (source) {
		metadata.source = truncateText(normalizeWhitespace(source), 64);
	}

	return metadata;
}

function parseMetadataFromBase64Flag(argv: string[]): Record<string, unknown> | null {
	const encoded = parseArgValue(argv, "--metadata-base64");
	if (!encoded) {
		return null;
	}
	try {
		return asRecord(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
	} catch {
		return null;
	}
}

function parseMetadataFromArgPayload(argv: string[]): Record<string, unknown> | null {
	for (let i = argv.length - 1; i >= 0; i -= 1) {
		const arg = argv[i];
		if (!arg || (!arg.startsWith("{") && !arg.startsWith("["))) {
			continue;
		}
		const parsed = parseJsonObject(arg);
		if (parsed) {
			return parsed;
		}
	}
	return null;
}

function extractToolInput(payload: Record<string, unknown>): Record<string, unknown> | null {
	const direct = asRecord(payload.tool_input);
	if (direct) {
		return direct;
	}
	const preTool = asRecord(payload.preToolUse);
	const preParams = preTool ? asRecord(preTool.parameters) : null;
	if (preParams) {
		return preParams;
	}
	const postTool = asRecord(payload.postToolUse);
	const postParams = postTool ? asRecord(postTool.parameters) : null;
	if (postParams) {
		return postParams;
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
		return `${toolName}: ${truncateText(command, 120)}`;
	}

	const filePath =
		readStringField(toolInput, "file_path") ??
		readStringField(toolInput, "filePath") ??
		readStringField(toolInput, "path");
	if (filePath) {
		return `${toolName}: ${truncateText(filePath, 120)}`;
	}

	return toolName;
}

function inferActivityText(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	toolName: string | null,
	finalMessage: string | null,
	notificationType: string | null,
): string | null {
	const hookEventName = payload
		? readStringField(payload, "hook_event_name") ??
			readStringField(payload, "hookEventName") ??
			readStringField(payload, "hookName")
		: null;
	const normalizedHookEvent = hookEventName?.toLowerCase() ?? "";
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
		return toolOperation ? `Using ${toolOperation}` : "Using tool";
	}
	if (normalizedHookEvent === "posttooluse" || normalizedHookEvent === "aftertool") {
		return toolOperation ? `Completed ${toolOperation}` : "Completed tool";
	}
	if (normalizedHookEvent === "posttoolusefailure") {
		const error = payload ? readStringField(payload, "error") : null;
		if (toolOperation && error) {
			return `Failed ${toolOperation}: ${truncateText(error, 100)}`;
		}
		if (toolOperation) {
			return `Failed ${toolOperation}`;
		}
		return error ? `Tool failed: ${truncateText(error, 100)}` : "Tool failed";
	}
	if (normalizedHookEvent === "permissionrequest") {
		return "Waiting for approval";
	}
	if (normalizedHookEvent === "userpromptsubmit" || normalizedHookEvent === "beforeagent") {
		return "Resumed after user input";
	}
	if (normalizedHookEvent === "stop" || normalizedHookEvent === "subagentstop" || normalizedHookEvent === "afteragent") {
		return finalMessage ? `Final: ${truncateText(finalMessage, 140)}` : "Waiting for review";
	}
	if (normalizedHookEvent === "taskcomplete") {
		return finalMessage ? `Final: ${truncateText(finalMessage, 140)}` : "Waiting for review";
	}

	if (notificationType === "permission_prompt" || notificationType === "permission.asked") {
		return "Waiting for approval";
	}
	if (notificationType === "user_attention") {
		return "Waiting for review";
	}

	if (event === "to_review") {
		return "Waiting for review";
	}
	if (event === "to_in_progress") {
		return "Agent active";
	}
	return null;
}

function normalizeHookMetadata(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	flagMetadata: Partial<RuntimeTaskHookActivity>,
): Partial<RuntimeTaskHookActivity> | undefined {
	const hookEventName = payload
		? readStringField(payload, "hook_event_name") ??
			readStringField(payload, "hookEventName") ??
			readStringField(payload, "hookName")
		: null;
	const toolName = payload
		? readStringField(payload, "tool_name") ??
			readNestedString(payload, ["preToolUse", "tool"]) ??
			readNestedString(payload, ["preToolUse", "toolName"]) ??
			readNestedString(payload, ["postToolUse", "tool"]) ??
			readNestedString(payload, ["postToolUse", "toolName"]) ??
			readNestedString(payload, ["input", "tool"])
		: null;
	const notificationType = payload
		? readStringField(payload, "notification_type") ??
			readNestedString(payload, ["event", "type"]) ??
			readNestedString(payload, ["notification", "event"])
		: null;
	const finalMessage = payload
		? readStringField(payload, "last_assistant_message") ??
			readStringField(payload, "last-assistant-message") ??
			readNestedString(payload, ["taskComplete", "taskMetadata", "result"]) ??
			readNestedString(payload, ["taskComplete", "result"])
		: null;

	const transcriptPath = payload ? readStringField(payload, "transcript_path") : null;
	let inferredSource: string | null = null;
	if (transcriptPath?.includes("/.claude/")) {
		inferredSource = "claude";
	} else if (transcriptPath?.includes("/.factory/")) {
		inferredSource = "droid";
	} else if (payload && readStringField(payload, "type") === "agent-turn-complete") {
		inferredSource = "codex";
	}

	const activityText = inferActivityText(event, payload, toolName, finalMessage, notificationType);
	const merged: Partial<RuntimeTaskHookActivity> = {
		source: flagMetadata.source ?? inferredSource ?? null,
		hookEventName: flagMetadata.hookEventName ?? hookEventName ?? null,
		toolName: flagMetadata.toolName ?? toolName ?? null,
		notificationType: flagMetadata.notificationType ?? notificationType ?? null,
		finalMessage:
			flagMetadata.finalMessage ??
			(finalMessage ? truncateText(normalizeWhitespace(finalMessage), MAX_FINAL_MESSAGE_LENGTH) : null),
		activityText:
			flagMetadata.activityText ??
			(activityText ? truncateText(normalizeWhitespace(activityText), MAX_ACTIVITY_TEXT_LENGTH) : null),
	};

	const hasValue = Object.values(merged).some((value) => typeof value === "string" && value.trim().length > 0);
	if (!hasValue) {
		return undefined;
	}

	if (typeof merged.source === "string") {
		merged.source = truncateText(merged.source, 64);
	}
	if (typeof merged.hookEventName === "string") {
		merged.hookEventName = truncateText(merged.hookEventName, 120);
	}
	if (typeof merged.toolName === "string") {
		merged.toolName = truncateText(merged.toolName, 120);
	}
	if (typeof merged.notificationType === "string") {
		merged.notificationType = truncateText(merged.notificationType, 120);
	}

	return merged;
}

function parseHooksIngestArgs(argv: string[], stdinPayload: string): HooksIngestArgs {
	const event = parseEventArg(argv);
	const context = parseHookRuntimeContextFromEnv();
	const flagMetadata = parseMetadataFromFlags(argv);
	const payloadFromBase64 = parseMetadataFromBase64Flag(argv);
	const payloadFromStdin = parseJsonObject(stdinPayload.trim());
	const payloadFromArg = parseMetadataFromArgPayload(argv);
	const payload = payloadFromBase64 ?? payloadFromStdin ?? payloadFromArg;
	const metadata = normalizeHookMetadata(event, payload, flagMetadata);
	return {
		event,
		taskId: context.taskId,
		workspaceId: context.workspaceId,
		metadata,
	};
}

async function ingestHookEvent(args: HooksIngestArgs): Promise<void> {
	const trpcClient = createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				maxItems: 1,
			}),
		],
	});
	const ingestResponse = await withTimeout(
		trpcClient.hooks.ingest.mutate({
			taskId: args.taskId,
			workspaceId: args.workspaceId,
			event: args.event,
			metadata: args.metadata,
		}),
		3000,
		"kanban hooks ingest",
	);
	if (ingestResponse.ok === false) {
		throw new Error(ingestResponse.error ?? "Hook ingest failed");
	}
}

function spawnDetachedKanban(args: string[]): void {
	try {
		const commandParts = buildKanbanCommandParts(args);
		const child = spawn(commandParts[0], commandParts.slice(1), {
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();
	} catch {
		// Best effort: hook notification failures should never block agents.
	}
}

function appendMetadataFlags(args: string[], metadata?: Partial<RuntimeTaskHookActivity>): string[] {
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
	if (metadata.finalMessage) {
		args.push("--final-message", metadata.finalMessage);
	}
	if (metadata.hookEventName) {
		args.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata.notificationType) {
		args.push("--notification-type", metadata.notificationType);
	}
	return args;
}

function getString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function parseCodexWrapperArgs(argv: string[]): CodexWrapperArgs {
	let realBinary = "";
	const passthroughArgs: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--real-binary") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("Missing value for --real-binary");
			}
			realBinary = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--real-binary=")) {
			realBinary = arg.slice("--real-binary=".length);
			continue;
		}
		if (arg === "--") {
			passthroughArgs.push(...argv.slice(index + 1));
			break;
		}
		passthroughArgs.push(arg);
	}

	if (!realBinary.trim()) {
		throw new Error("Missing required flag: --real-binary");
	}
	return {
		realBinary,
		agentArgs: passthroughArgs,
	};
}

function parseCodexSessionLogLine(line: string): CodexSessionLogLine | null {
	try {
		const parsed = JSON.parse(line) as CodexSessionLogLine;
		const dir = getString(parsed.dir);
		const kind = getString(parsed.kind);
		const hasStructuredMsg = Boolean(parsed.msg && typeof parsed.msg === "object" && !Array.isArray(parsed.msg));
		const isCodexEventLine =
			(kind === "codex_event" && (dir === "to_tui" || dir === "")) ||
			(kind === "" && hasStructuredMsg) ||
			(dir === "to_tui" && hasStructuredMsg);
		if (!isCodexEventLine) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function parseCodexEventPayload(line: CodexSessionLogLine): CodexEventPayload | null {
	const payload = asRecord(line.payload);
	if (payload) {
		const payloadMsg = asRecord(payload.msg);
		if (payloadMsg) {
			return payloadMsg as CodexEventPayload;
		}
		if (typeof payload.type === "string") {
			return payload as CodexEventPayload;
		}
	}

	if (line.msg && typeof line.msg === "object" && !Array.isArray(line.msg)) {
		return line.msg as CodexEventPayload;
	}
	if (typeof line === "object" && line !== null && "type" in line) {
		return line as CodexEventPayload;
	}
	return null;
}

function parseJsonString(value: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		return asRecord(parsed);
	} catch {
		return null;
	}
}

function extractCodexCommandSnippet(message: CodexEventPayload, line: string): string | null {
	const directCommand = pickFirstString([
		extractJsonStringField(line, "command"),
		extractJsonStringField(line, "cmd"),
		message.command,
	]);
	if (directCommand) {
		return directCommand;
	}

	if (Array.isArray(message.command)) {
		const commandText = message.command.filter((part): part is string => typeof part === "string").join(" ").trim();
		if (commandText) {
			return commandText;
		}
	}

	const item = asRecord(message.item);
	if (item?.type === "function_call") {
		const argsRaw = typeof item.arguments === "string" ? item.arguments : "";
		const args = argsRaw ? parseJsonString(argsRaw) : null;
		const cmd = args ? readStringField(args, "cmd") : null;
		if (cmd) {
			return cmd;
		}
	}

	return null;
}

function pickFirstString(values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return "";
}

function extractJsonStringField(line: string, field: string): string {
	const pattern = new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`);
	const match = line.match(pattern);
	if (!match?.[1]) {
		return "";
	}
	try {
		return JSON.parse(`"${match[1]}"`) as string;
	} catch {
		return match[1];
	}
}

function parseCodexEventLine(
	line: string,
	state: CodexWatcherState,
): { event: RuntimeHookEvent; metadata?: Partial<RuntimeTaskHookActivity> } | null {
	const parsed = parseCodexSessionLogLine(line);
	if (!parsed) {
		return null;
	}
	const message = parseCodexEventPayload(parsed);
	if (!message) {
		return null;
	}
	const type = getString(message?.type);
	if (!type) {
		return null;
	}
	const normalizedType = type.toLowerCase();
	const command = extractCodexCommandSnippet(message, line);
	const messageText = typeof message.message === "string" ? normalizeWhitespace(message.message) : "";
	const lastAgentMessage = typeof message.last_agent_message === "string" ? normalizeWhitespace(message.last_agent_message) : "";

	if (normalizedType === "task_started" || normalizedType === "turn_started" || normalizedType === "turn_begin") {
		const turnId = pickFirstString([
			extractJsonStringField(line, "turn_id"),
			message?.turn_id,
			parsed.turn_id,
			normalizedType,
		]);
		if (turnId !== state.lastTurnId) {
			state.lastTurnId = turnId;
			return {
				event: "to_in_progress",
				metadata: {
					source: "codex",
					activityText: command ? `Working on task: ${truncateText(command, 120)}` : "Working on task",
					hookEventName: type,
				},
			};
		}
		return null;
	}

	if (normalizedType === "raw_response_item") {
		const item = asRecord(message.item);
		if (item?.type === "function_call") {
			const callId = readStringField(item, "call_id") ?? pickFirstString([message.call_id, parsed.call_id]);
			const name = readStringField(item, "name") ?? "tool";
			const fingerprint = callId || `${name}:${command ?? ""}`;
			if (fingerprint === state.lastActivityFingerprint) {
				return null;
			}
			state.lastActivityFingerprint = fingerprint;
			return {
				event: "activity",
				metadata: {
					source: "codex",
					hookEventName: type,
					activityText: command
						? `Calling ${name}: ${truncateText(command, 120)}`
						: `Calling ${truncateText(name, 48)}`,
				},
			};
		}
		return null;
	}

	if (normalizedType === "agent_message" && messageText) {
		const fingerprint = `${normalizedType}:${truncateText(messageText, 120)}`;
		if (fingerprint === state.lastActivityFingerprint) {
			return null;
		}
		state.lastActivityFingerprint = fingerprint;
		return {
			event: "activity",
			metadata: {
				source: "codex",
				hookEventName: type,
				activityText: `Agent: ${truncateText(messageText, 140)}`,
			},
		};
	}

	if (normalizedType === "task_complete") {
		const finalText = lastAgentMessage || messageText;
		return {
			event: "to_review",
			metadata: {
				source: "codex",
				hookEventName: type,
				activityText: finalText ? `Final: ${truncateText(finalText, 140)}` : "Waiting for review",
				finalMessage: finalText || undefined,
			},
		};
	}

	if (
		normalizedType.endsWith("_approval_request") ||
		normalizedType === "approval_request" ||
		normalizedType === "permission_request" ||
		normalizedType === "approval_requested"
	) {
		let approvalId = pickFirstString([
			extractJsonStringField(line, "id"),
			extractJsonStringField(line, "approval_id"),
			extractJsonStringField(line, "call_id"),
			message?.id,
			message?.approval_id,
			message?.call_id,
			parsed.id,
			parsed.approval_id,
			parsed.call_id,
		]);
		if (!approvalId) {
			state.approvalFallbackSeq += 1;
			approvalId = `approval_request_${state.approvalFallbackSeq}`;
		}
		if (approvalId !== state.lastApprovalId) {
			state.lastApprovalId = approvalId;
			return {
				event: "to_review",
				metadata: {
					source: "codex",
					activityText: "Waiting for approval",
					hookEventName: type,
				},
			};
		}
		return null;
	}

	if (normalizedType === "exec_command_begin" || normalizedType === "exec_command_start") {
		const callId = pickFirstString([extractJsonStringField(line, "call_id"), message?.call_id, parsed.call_id]);
		if (!callId || callId !== state.lastExecCallId) {
			state.lastExecCallId = callId;
			return {
				event: "activity",
				metadata: {
					source: "codex",
					activityText: command ? `Running command: ${truncateText(command, 120)}` : "Running command",
					hookEventName: type,
				},
			};
		}
		return null;
	}

	if (normalizedType === "exec_command_end") {
		const callId = pickFirstString([extractJsonStringField(line, "call_id"), message.call_id, parsed.call_id]);
		const status = pickFirstString([extractJsonStringField(line, "status"), (message as Record<string, unknown>).status]);
		const failed = status.toLowerCase() === "failed";
		const fingerprint = `${normalizedType}:${callId}:${status}`;
		if (fingerprint === state.lastActivityFingerprint) {
			return null;
		}
		state.lastActivityFingerprint = fingerprint;
		return {
			event: "activity",
			metadata: {
				source: "codex",
				hookEventName: type,
				activityText: failed
					? command
						? `Command failed: ${truncateText(command, 120)}`
						: "Command failed"
					: command
						? `Command finished: ${truncateText(command, 120)}`
						: "Command finished",
			},
		};
	}

	if (normalizedType.includes("tool") || normalizedType.includes("exec") || normalizedType.includes("command")) {
		const fingerprint = pickFirstString([
			extractJsonStringField(line, "call_id"),
			extractJsonStringField(line, "id"),
			type,
		]);
		if (fingerprint === state.lastActivityFingerprint) {
			return null;
		}
		state.lastActivityFingerprint = fingerprint;
		return {
			event: "activity",
			metadata: {
				source: "codex",
				activityText: command
					? `Codex ${type}: ${truncateText(command, 120)}`
					: `Codex activity: ${truncateText(type, 64)}`,
				hookEventName: type,
			},
		};
	}

	return null;
}

async function waitForFile(path: string): Promise<boolean> {
	for (let attempt = 0; attempt < CODEX_LOG_WAIT_ATTEMPTS; attempt += 1) {
		try {
			await access(path);
			return true;
		} catch {
			await sleep(CODEX_LOG_WAIT_DELAY_MS);
		}
	}
	return false;
}

async function startCodexSessionWatcher(logPath: string): Promise<() => void> {
	const state: CodexWatcherState = {
		lastTurnId: "",
		lastApprovalId: "",
		lastExecCallId: "",
		lastActivityFingerprint: "",
		approvalFallbackSeq: 0,
		offset: 0,
		remainder: "",
	};

	const poll = async () => {
		let fileStat: Stats;
		try {
			fileStat = await stat(logPath);
		} catch {
			return;
		}
		if (fileStat.size < state.offset) {
			state.offset = 0;
			state.remainder = "";
		}
		if (fileStat.size === state.offset) {
			return;
		}

		let handle: Awaited<ReturnType<typeof open>> | null = null;
		try {
			handle = await open(logPath, "r");
			const byteLength = fileStat.size - state.offset;
			const buffer = Buffer.alloc(byteLength);
			await handle.read(buffer, 0, byteLength, state.offset);
			state.offset = fileStat.size;
			const combined = state.remainder + buffer.toString("utf8");
			const lines = combined.split(/\r?\n/);
			state.remainder = lines.pop() ?? "";
			for (const line of lines) {
				const mapped = parseCodexEventLine(line, state);
				if (mapped) {
					spawnDetachedKanban(
						appendMetadataFlags(["hooks", "notify", "--event", mapped.event], mapped.metadata),
					);
				}
			}
		} catch {
			// Ignore transient session log read errors.
		} finally {
			await handle?.close();
		}
	};

	const timer = setInterval(() => {
		void poll();
	}, CODEX_LOG_POLL_INTERVAL_MS);
	void poll();
	return () => {
		clearInterval(timer);
	};
}

async function runHooksNotify(argv: string[]): Promise<void> {
	try {
		const stdinPayload = await readStdinText();
		const args = parseHooksIngestArgs(argv.slice(2), stdinPayload);
		await ingestHookEvent(args);
	} catch {
		// Best effort only.
	}
}

async function readStdinText(): Promise<string> {
	if (process.stdin.isTTY) {
		return "";
	}
	const chunks: string[] = [];
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	return chunks.join("");
}

function mapGeminiHookEvent(eventName: string): RuntimeHookEvent | null {
	if (eventName === "AfterAgent") {
		return "to_review";
	}
	if (eventName === "BeforeAgent") {
		return "to_in_progress";
	}
	if (eventName === "AfterTool" || eventName === "BeforeTool" || eventName === "Notification") {
		return "activity";
	}
	return null;
}

async function runGeminiHookSubcommand(): Promise<void> {
	let payload = "";
	try {
		payload = await readStdinText();
	} catch {
		payload = "";
	}

	let hookEventName = "";
	let payloadRecord: Record<string, unknown> | null = null;
	try {
		const parsed = JSON.parse(payload || "{}") as { hook_event_name?: unknown };
		payloadRecord = asRecord(parsed);
		hookEventName =
			typeof parsed.hook_event_name === "string"
				? parsed.hook_event_name
				: payloadRecord && typeof payloadRecord.hookEventName === "string"
					? payloadRecord.hookEventName
					: "";
	} catch {
		hookEventName = "";
		payloadRecord = null;
	}

	process.stdout.write("{}\n");

	const mappedEvent = mapGeminiHookEvent(hookEventName);
	if (!mappedEvent) {
		return;
	}
	const metadata = normalizeHookMetadata(mappedEvent, payloadRecord, {
		source: "gemini",
		hookEventName: hookEventName || undefined,
	});
	spawnDetachedKanban(appendMetadataFlags(["hooks", "notify", "--event", mappedEvent], metadata));
}

async function runCodexWrapperSubcommand(argv: string[]): Promise<void> {
	let wrapperArgs: CodexWrapperArgs;
	try {
		wrapperArgs = parseCodexWrapperArgs(argv.slice(2));
	} catch (error) {
		process.stderr.write(`kanban hooks codex-wrapper: ${formatError(error)}\n`);
		process.exitCode = 1;
		return;
	}

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	let shuttingDown = false;
	let stopWatcher = () => {};

	let shouldWatchSessionLog = false;
	try {
		parseHookRuntimeContextFromEnv(childEnv);
		shouldWatchSessionLog = true;
	} catch {
		shouldWatchSessionLog = false;
	}

	if (shouldWatchSessionLog) {
		childEnv.CODEX_TUI_RECORD_SESSION = "1";
		if (!childEnv.CODEX_TUI_SESSION_LOG_PATH) {
			childEnv.CODEX_TUI_SESSION_LOG_PATH = join(
				tmpdir(),
				`kanban-codex-session-${process.pid}_${Date.now()}.jsonl`,
			);
		}
		const sessionLogPath = childEnv.CODEX_TUI_SESSION_LOG_PATH;
		if (sessionLogPath) {
			void (async () => {
				const exists = await waitForFile(sessionLogPath);
				if (!exists || shuttingDown) {
					return;
				}
				stopWatcher = await startCodexSessionWatcher(sessionLogPath);
				if (shuttingDown) {
					stopWatcher();
				}
			})();
		}
	}

	const reviewNotifyCommandParts = buildKanbanCommandParts([
		"hooks",
		"notify",
		"--event",
		"to_review",
		"--source",
		"codex",
	]);
	const notifyConfig = `notify=${JSON.stringify(reviewNotifyCommandParts)}`;
	const child = spawn(wrapperArgs.realBinary, ["-c", notifyConfig, ...wrapperArgs.agentArgs], {
		stdio: "inherit",
		env: childEnv,
	});

	const forwardSignal = (signal: NodeJS.Signals) => {
		if (!child.killed) {
			child.kill(signal);
		}
	};

	const onSigint = () => {
		forwardSignal("SIGINT");
	};
	const onSigterm = () => {
		forwardSignal("SIGTERM");
	};

	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	const cleanup = () => {
		shuttingDown = true;
		stopWatcher();
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	};

	await new Promise<void>((resolve) => {
		child.on("error", () => {
			cleanup();
			process.exitCode = 1;
			resolve();
		});
		child.on("exit", (code) => {
			cleanup();
			process.exitCode = code ?? 1;
			resolve();
		});
	});
}

export function isHooksSubcommand(argv: string[]): boolean {
	return argv[0] === "hooks";
}

export async function runHooksIngest(argv: string[]): Promise<void> {
	let args: HooksIngestArgs;
	try {
		const stdinPayload = await readStdinText();
		args = parseHooksIngestArgs(argv.slice(2), stdinPayload);
	} catch (error) {
		process.stderr.write(`kanban hooks ingest: ${formatError(error)}\n`);
		process.exitCode = 1;
		return;
	}

	try {
		await ingestHookEvent(args);
	} catch (error) {
		process.stderr.write(`kanban hooks ingest: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}

export async function runHooksSubcommand(argv: string[]): Promise<void> {
	const subcommand = argv[1];
	if (subcommand === "ingest") {
		await runHooksIngest(argv);
		return;
	}
	if (subcommand === "notify") {
		await runHooksNotify(argv);
		return;
	}
	if (subcommand === "gemini-hook") {
		await runGeminiHookSubcommand();
		return;
	}
	if (subcommand === "codex-wrapper") {
		await runCodexWrapperSubcommand(argv);
		return;
	}
	process.stderr.write(
		`kanban hooks: unknown subcommand "${subcommand ?? ""}". Expected one of: ingest, notify, gemini-hook, codex-wrapper\n`,
	);
	process.exitCode = 1;
}
