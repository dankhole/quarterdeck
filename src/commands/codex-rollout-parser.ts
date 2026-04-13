import type { Dirent, Stats } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CodexMappedHookEvent } from "./codex-session-parser";

// ── Constants ───────────────────────────────────────────────────────────────────

const MAX_CODEX_ROLLOUT_FILES_TO_SCAN = 250;
const CODEX_ROLLOUT_FILE_FRESH_WINDOW_MS = 10 * 60 * 1000;
const CODEX_ROLLOUT_MATCH_SCAN_BYTES = 256 * 1024;
const CODEX_ROLLOUT_TAIL_SCAN_BYTES = 2 * 1024 * 1024;

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

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function normalizePathForComparison(path: string): string {
	return path.replaceAll("\\", "/");
}

// ── File I/O helpers ────────────────────────────────────────────────────────────

async function readFilePrefix(filePath: string, byteLength: number): Promise<string> {
	if (byteLength <= 0) {
		return "";
	}
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(filePath, "r");
		const buffer = Buffer.alloc(byteLength);
		const readResult = await handle.read(buffer, 0, byteLength, 0);
		return buffer.subarray(0, readResult.bytesRead).toString("utf8");
	} finally {
		await handle?.close();
	}
}

async function readFileTail(filePath: string, fileSize: number, maxBytes: number): Promise<string> {
	if (fileSize <= 0 || maxBytes <= 0) {
		return "";
	}
	const byteLength = Math.min(fileSize, maxBytes);
	const start = Math.max(0, fileSize - byteLength);
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(filePath, "r");
		const buffer = Buffer.alloc(byteLength);
		const readResult = await handle.read(buffer, 0, byteLength, start);
		return buffer.subarray(0, readResult.bytesRead).toString("utf8");
	} finally {
		await handle?.close();
	}
}

// ── Rollout file discovery ──────────────────────────────────────────────────────

async function listCodexRolloutFiles(rootPath: string): Promise<string[]> {
	const stack = [rootPath];
	const files: string[] = [];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}

		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const entryPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
				files.push(entryPath);
			}
		}
	}

	files.sort((a, b) => b.localeCompare(a));
	return files;
}

// ── Rollout line extraction ─────────────────────────────────────────────────────

function extractFinalMessageFromRolloutLine(lineRecord: Record<string, unknown>): string | null {
	const lineType = readStringField(lineRecord, "type");
	if (lineType === "event_msg") {
		const payload = asRecord(lineRecord.payload);
		const payloadType = payload ? readStringField(payload, "type") : null;
		if (payloadType === "task_complete") {
			const lastAgentMessage = payload ? readStringField(payload, "last_agent_message") : null;
			if (lastAgentMessage) {
				return lastAgentMessage;
			}
		}
		if (payloadType === "agent_message") {
			const phase = payload ? readStringField(payload, "phase") : null;
			const message = payload ? readStringField(payload, "message") : null;
			if (phase === "final_answer" && message) {
				return message;
			}
		}
	}

	if (lineType === "response_item") {
		const payload = asRecord(lineRecord.payload);
		if (!payload) {
			return null;
		}
		const payloadType = readStringField(payload, "type");
		const role = readStringField(payload, "role");
		const phase = readStringField(payload, "phase");
		if (payloadType !== "message" || role !== "assistant" || phase !== "final_answer") {
			return null;
		}
		const content = payload.content;
		if (!Array.isArray(content)) {
			return null;
		}
		for (let index = content.length - 1; index >= 0; index -= 1) {
			const item = asRecord(content[index]);
			if (!item) {
				continue;
			}
			if (readStringField(item, "type") !== "output_text") {
				continue;
			}
			const text = readStringField(item, "text");
			if (text) {
				return text;
			}
		}
	}

	return null;
}

function extractRolloutCommandFromArgsString(argsRaw: string | null): string | null {
	if (!argsRaw) {
		return null;
	}
	const args = parseJsonObject(argsRaw);
	if (!args) {
		return null;
	}
	const command = readStringField(args, "cmd") ?? readStringField(args, "command") ?? readStringField(args, "query");
	return command || null;
}

function extractRolloutCommandFromPayload(payload: Record<string, unknown>): string | null {
	const parsedCommands = payload.parsed_cmd;
	if (Array.isArray(parsedCommands)) {
		for (const item of parsedCommands) {
			const parsedItem = asRecord(item);
			if (!parsedItem) {
				continue;
			}
			const parsedCommand = readStringField(parsedItem, "cmd");
			if (parsedCommand) {
				return parsedCommand;
			}
		}
	}

	const commandArray = payload.command;
	if (Array.isArray(commandArray)) {
		const commandParts = commandArray.filter((part): part is string => typeof part === "string");
		if (commandParts.length >= 3 && commandParts[1] === "-lc") {
			const shellCommand = normalizeWhitespace(commandParts[2] ?? "");
			if (shellCommand) {
				return shellCommand;
			}
		}
		const combined = normalizeWhitespace(commandParts.join(" "));
		if (combined) {
			return combined;
		}
	}

	const command =
		readStringField(payload, "cmd") ?? readStringField(payload, "command") ?? readStringField(payload, "query");
	return command || null;
}

// ── Public API ──────────────────────────────────────────────────────────────────

export async function resolveCodexRolloutFinalMessageForCwd(
	cwd: string,
	sessionsRoot = join(homedir(), ".codex", "sessions"),
): Promise<string | null> {
	if (!cwd.trim()) {
		return null;
	}
	const normalizedCwd = normalizePathForComparison(cwd);
	const encodedCwd = JSON.stringify(normalizedCwd);
	const rolloutFiles = (await listCodexRolloutFiles(sessionsRoot)).slice(0, MAX_CODEX_ROLLOUT_FILES_TO_SCAN);

	for (const filePath of rolloutFiles) {
		let fileStat: Stats;
		try {
			fileStat = await stat(filePath);
		} catch {
			continue;
		}

		let prefix = "";
		try {
			prefix = await readFilePrefix(filePath, Math.min(fileStat.size, CODEX_ROLLOUT_MATCH_SCAN_BYTES));
		} catch {
			continue;
		}
		if (!prefix.includes(`"cwd":${encodedCwd}`)) {
			continue;
		}

		let scanText = "";
		try {
			scanText = await readFileTail(filePath, fileStat.size, CODEX_ROLLOUT_TAIL_SCAN_BYTES);
		} catch {
			continue;
		}
		const lines = scanText.split(/\r?\n/);
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index]?.trim();
			if (!line) {
				continue;
			}
			const parsedLine = parseJsonObject(line);
			if (!parsedLine) {
				continue;
			}
			const finalMessage = extractFinalMessageFromRolloutLine(parsedLine);
			if (finalMessage) {
				return finalMessage;
			}
		}
	}

	return null;
}

export async function findCodexRolloutFileForCwd(
	cwd: string,
	sessionStartedAtMs: number,
	sessionsRoot: string,
): Promise<string | null> {
	if (!cwd.trim()) {
		return null;
	}
	const normalizedCwd = normalizePathForComparison(cwd);
	const encodedCwd = JSON.stringify(normalizedCwd);
	const rolloutFiles = (await listCodexRolloutFiles(sessionsRoot)).slice(0, MAX_CODEX_ROLLOUT_FILES_TO_SCAN);

	for (const filePath of rolloutFiles) {
		let fileStat: Stats;
		try {
			fileStat = await stat(filePath);
			if (fileStat.mtimeMs < sessionStartedAtMs - CODEX_ROLLOUT_FILE_FRESH_WINDOW_MS) {
				continue;
			}
		} catch {
			continue;
		}

		let prefix = "";
		try {
			prefix = await readFilePrefix(filePath, Math.min(fileStat.size, CODEX_ROLLOUT_MATCH_SCAN_BYTES));
		} catch {
			continue;
		}
		if (prefix.includes(`"cwd":${encodedCwd}`)) {
			return filePath;
		}
	}

	return null;
}

export function mapCodexRolloutActivityLine(
	line: string,
): { mapped: CodexMappedHookEvent; fingerprint: string } | null {
	const parsedLine = parseJsonObject(line);
	if (!parsedLine) {
		return null;
	}
	const lineType = readStringField(parsedLine, "type");
	if (!lineType) {
		return null;
	}
	if (lineType === "event_msg") {
		const payload = asRecord(parsedLine.payload);
		if (!payload) {
			return null;
		}
		const payloadType = readStringField(payload, "type");
		if (!payloadType) {
			return null;
		}
		const normalizedType = payloadType.toLowerCase();
		if (normalizedType === "agent_message") {
			const phase = readStringField(payload, "phase");
			const message = readStringField(payload, "message");
			if (phase === "final_answer" && message) {
				return {
					fingerprint: `rollout:final_answer:${truncateText(message, 160)}`,
					mapped: {
						event: "to_review",
						metadata: {
							source: "codex",
							hookEventName: payloadType,
							activityText: `Final: ${message}`,
							finalMessage: message,
						},
					},
				};
			}
			if (phase === "commentary" && message) {
				return {
					fingerprint: `rollout:agent_message:${truncateText(message, 140)}`,
					mapped: {
						event: "activity",
						metadata: {
							source: "codex",
							hookEventName: payloadType,
							activityText: `Agent: ${message}`,
						},
					},
				};
			}
			return null;
		}
		if (normalizedType === "task_complete") {
			const finalMessage = readStringField(payload, "last_agent_message");
			return {
				fingerprint: `rollout:task_complete:${truncateText(finalMessage ?? "", 160)}`,
				mapped: {
					event: "to_review",
					metadata: {
						source: "codex",
						hookEventName: payloadType,
						activityText: finalMessage ? `Final: ${finalMessage}` : "Waiting for review",
						finalMessage: finalMessage ?? undefined,
					},
				},
			};
		}
		if (normalizedType === "exec_command_begin" || normalizedType === "exec_command_start") {
			const callId = readStringField(payload, "call_id") ?? "unknown";
			const command = extractRolloutCommandFromPayload(payload);
			return {
				fingerprint: `rollout:exec_begin:${callId}:${command ?? ""}`,
				mapped: {
					event: "activity",
					metadata: {
						source: "codex",
						hookEventName: payloadType,
						activityText: command ? `Running command: ${command}` : "Running command",
					},
				},
			};
		}
		if (normalizedType === "exec_command_end") {
			const callId = readStringField(payload, "call_id") ?? "unknown";
			const command = extractRolloutCommandFromPayload(payload);
			const status = (readStringField(payload, "status") ?? "completed").toLowerCase();
			const failed = status === "failed";
			return {
				fingerprint: `rollout:exec_end:${callId}:${status}:${command ?? ""}`,
				mapped: {
					event: "activity",
					metadata: {
						source: "codex",
						hookEventName: payloadType,
						activityText: failed
							? command
								? `Command failed: ${command}`
								: "Command failed"
							: command
								? `Command finished: ${command}`
								: "Command finished",
					},
				},
			};
		}
		return null;
	}
	if (lineType === "response_item") {
		const payload = asRecord(parsedLine.payload);
		if (!payload) {
			return null;
		}
		const payloadType = readStringField(payload, "type");
		if (payloadType === "function_call") {
			const name = readStringField(payload, "name") ?? "tool";
			const callId = readStringField(payload, "call_id") ?? "unknown";
			const command = extractRolloutCommandFromArgsString(readStringField(payload, "arguments"));
			return {
				fingerprint: `rollout:function_call:${callId}:${name}:${command ?? ""}`,
				mapped: {
					event: "activity",
					metadata: {
						source: "codex",
						hookEventName: payloadType,
						activityText: command ? `Calling ${name}: ${command}` : `Calling ${name}`,
					},
				},
			};
		}
	}
	return null;
}
