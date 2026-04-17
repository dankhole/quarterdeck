import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../core";

// ── Shared types ────────────────────────────────────────────────────────────────

export interface CodexMappedHookEvent {
	event: RuntimeHookEvent;
	metadata?: Partial<RuntimeTaskHookActivity>;
}

export type CodexSessionWatcherNotify = (mapped: CodexMappedHookEvent) => void;

// ── String / JSON helpers ───────────────────────────────────────────────────────

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
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

function getString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function parseJsonString(value: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		return asRecord(parsed);
	} catch {
		return null;
	}
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

// ── Internal types ──────────────────────────────────────────────────────────────

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

// ── Watcher state ───────────────────────────────────────────────────────────────

export interface CodexWatcherState {
	lastTurnId: string;
	lastApprovalId: string;
	lastExecCallId: string;
	lastActivityFingerprint: string;
	approvalFallbackSeq: number;
	offset: number;
	remainder: string;
	currentSessionScope: "unknown" | "root" | "descendant";
}

export function createCodexWatcherState(): CodexWatcherState {
	return {
		lastTurnId: "",
		lastApprovalId: "",
		lastExecCallId: "",
		lastActivityFingerprint: "",
		approvalFallbackSeq: 0,
		offset: 0,
		remainder: "",
		currentSessionScope: "unknown",
	};
}

// ── Line parsing helpers ────────────────────────────────────────────────────────

function parseCodexSessionLogLine(line: string): CodexSessionLogLine | null {
	try {
		const parsed = JSON.parse(line) as CodexSessionLogLine;
		const dir = getString(parsed.dir);
		const kind = getString(parsed.kind);
		const hasStructuredMsg = Boolean(parsed.msg && typeof parsed.msg === "object" && !Array.isArray(parsed.msg));
		const payload = asRecord(parsed.payload);
		const payloadType = payload ? readStringField(payload, "type") : null;
		const isCodexEventLine =
			(kind === "codex_event" && (dir === "to_tui" || dir === "")) ||
			(kind === "op" &&
				(dir === "from_tui" || dir === "to_tui" || dir === "") &&
				typeof payloadType === "string" &&
				payloadType.length > 0) ||
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
		const commandText = message.command
			.filter((part): part is string => typeof part === "string")
			.join(" ")
			.trim();
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

function isCodexDescendantSession(message: unknown): boolean {
	const messageRecord = asRecord(message);
	const payload = messageRecord ? asRecord(messageRecord.payload) : null;
	const source = payload ? asRecord(payload.source) : null;
	const subagent = source ? asRecord(source.subagent) : null;
	const threadSpawn = subagent ? asRecord(subagent.thread_spawn) : null;
	return threadSpawn !== null;
}

// ── Public event line parser ────────────────────────────────────────────────────

export function parseCodexEventLine(line: string, state: CodexWatcherState): CodexMappedHookEvent | null {
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
	if (normalizedType === "session_meta") {
		state.currentSessionScope = isCodexDescendantSession(message) ? "descendant" : "root";
		return null;
	}
	if (state.currentSessionScope === "descendant") {
		if (normalizedType === "task_complete" || normalizedType === "turn_aborted") {
			state.currentSessionScope = "unknown";
		}
		return null;
	}
	const command = extractCodexCommandSnippet(message, line);
	const messageText = typeof message.message === "string" ? normalizeWhitespace(message.message) : "";
	const lastAgentMessage =
		typeof message.last_agent_message === "string" ? normalizeWhitespace(message.last_agent_message) : "";

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
					activityText: command ? `Working on task: ${command}` : "Working on task",
					hookEventName: type,
				},
			};
		}
		return null;
	}

	if (normalizedType === "user_turn") {
		return {
			event: "to_in_progress",
			metadata: {
				source: "codex",
				activityText: "Resumed after user input",
				hookEventName: type,
			},
		};
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
					activityText: command ? `Calling ${name}: ${command}` : `Calling ${name}`,
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
				activityText: `Agent: ${messageText}`,
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
				activityText: finalText ? `Final: ${finalText}` : "Waiting for review",
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
					activityText: command ? `Running command: ${command}` : "Running command",
					hookEventName: type,
				},
			};
		}
		return null;
	}

	if (normalizedType === "exec_command_end") {
		const callId = pickFirstString([extractJsonStringField(line, "call_id"), message.call_id, parsed.call_id]);
		const status = pickFirstString([
			extractJsonStringField(line, "status"),
			(message as Record<string, unknown>).status,
		]);
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
						? `Command failed: ${command}`
						: "Command failed"
					: command
						? `Command finished: ${command}`
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
				activityText: command ? `Codex ${type}: ${command}` : `Codex activity: ${type}`,
				hookEventName: type,
			},
		};
	}

	return null;
}
