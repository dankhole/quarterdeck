import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../core";

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
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
	finalMessage?: string;
	hookEventName?: string;
	notificationType?: string;
	metadataBase64?: string;
}

export function parseMetadataFromOptions(options: HookCommandMetadataOptionValues): Partial<RuntimeTaskHookActivity> {
	const metadata: Partial<RuntimeTaskHookActivity> = {};
	const activityText = options.activityText;
	const toolName = options.toolName;
	const finalMessage = options.finalMessage;
	const hookEventName = options.hookEventName;
	const notificationType = options.notificationType;
	const source = options.source;

	if (activityText) {
		metadata.activityText = normalizeWhitespace(activityText);
	}
	if (toolName) {
		metadata.toolName = normalizeWhitespace(toolName);
	}
	if (finalMessage) {
		metadata.finalMessage = normalizeWhitespace(finalMessage);
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
): string | null {
	const hookEventName = payload
		? (readStringField(payload, "hook_event_name") ??
			readStringField(payload, "hookEventName") ??
			readStringField(payload, "hookName"))
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
	if (normalizedHookEvent === "userpromptsubmit" || normalizedHookEvent === "beforeagent") {
		return "Resumed after user input";
	}
	if (
		normalizedHookEvent === "stop" ||
		normalizedHookEvent === "subagentstop" ||
		normalizedHookEvent === "afteragent"
	) {
		return finalMessage ? `Final: ${finalMessage}` : null;
	}
	if (normalizedHookEvent === "taskcomplete") {
		return finalMessage ? `Final: ${finalMessage}` : null;
	}

	if (notificationType === "permission_prompt" || notificationType === "permission.asked") {
		return "Waiting for approval";
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

export function inferHookSourceFromPayload(payload: Record<string, unknown> | null): string | null {
	const transcriptPath = payload
		? (readStringField(payload, "transcript_path") ?? readStringField(payload, "transcriptPath"))
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
	flagMetadata: Partial<RuntimeTaskHookActivity>,
): Partial<RuntimeTaskHookActivity> | undefined {
	const hookEventName = payload
		? (readStringField(payload, "hook_event_name") ??
			readStringField(payload, "hookEventName") ??
			readStringField(payload, "hookName"))
		: null;
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
	const finalMessage = payload
		? (readStringField(payload, "last_assistant_message") ??
			readStringField(payload, "lastAssistantMessage") ??
			readStringField(payload, "last-assistant-message") ??
			readNestedString(payload, ["taskComplete", "taskMetadata", "result"]) ??
			readNestedString(payload, ["taskComplete", "result"]))
		: null;

	const inferredSource = inferHookSourceFromPayload(payload);

	const activityText = inferActivityText(event, payload, toolName, finalMessage, notificationType);
	const merged: Partial<RuntimeTaskHookActivity> = {
		source: flagMetadata.source ?? inferredSource ?? null,
		hookEventName: flagMetadata.hookEventName ?? hookEventName ?? null,
		toolName: flagMetadata.toolName ?? toolName ?? null,
		notificationType: flagMetadata.notificationType ?? notificationType ?? null,
		finalMessage: flagMetadata.finalMessage ?? (finalMessage ? normalizeWhitespace(finalMessage) : null),
		activityText: flagMetadata.activityText ?? (activityText ? normalizeWhitespace(activityText) : null),
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

export function appendMetadataFlags(args: string[], metadata?: Partial<RuntimeTaskHookActivity>): string[] {
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
