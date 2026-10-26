import { isJsonObject } from "./provider-record-utils.js";

export interface PiProgressEntry {
	id: string;
	parentId: string | null;
	recordedAt: number;
	/** Only persisted foreground assistant text; never extension or nested tool content. */
	text: string | null;
	boundary: boolean;
	invalidatesPreview: boolean;
	editedEntryId: string | null;
}

const METADATA_TYPES = new Set([
	"model_change",
	"thinking_level_change",
	"usage",
	"custom",
	"custom_message",
	"context_edit",
	"label",
	"session_info",
]);
const IGNORED_MESSAGE_ROLES = new Set([
	"user",
	"system",
	"toolResult",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);
const MAX_ID_LENGTH = 512;

/** Read-only subset of Pi v3. Unknown shapes invalidate progress, not provider history. */
export function parsePiProgressEntry(value: unknown): PiProgressEntry | null {
	if (
		!isJsonObject(value) ||
		typeof value.id !== "string" ||
		!value.id ||
		value.id.length > MAX_ID_LENGTH ||
		!(
			value.parentId === null ||
			(typeof value.parentId === "string" && value.parentId.length > 0 && value.parentId.length <= MAX_ID_LENGTH)
		) ||
		value.parentId === value.id ||
		typeof value.timestamp !== "string"
	)
		return null;
	const recordedAt = Date.parse(value.timestamp);
	if (!Number.isFinite(recordedAt)) return null;
	const result: PiProgressEntry = {
		id: value.id,
		parentId: value.parentId,
		recordedAt,
		text: null,
		boundary: value.type === "branch_summary" || value.type === "compaction",
		invalidatesPreview: false,
		editedEntryId: null,
	};
	if (value.type === "context_edit") {
		if (typeof value.targetId !== "string" || !value.targetId || value.targetId.length > MAX_ID_LENGTH) return null;
		result.editedEntryId = value.targetId;
	}
	if (result.boundary || (typeof value.type === "string" && METADATA_TYPES.has(value.type))) return result;
	if (value.type !== "message" || !isJsonObject(value.message)) return null;
	const message = value.message;
	if (typeof message.role === "string" && IGNORED_MESSAGE_ROLES.has(message.role)) return result;
	if (
		message.role !== "assistant" ||
		!Array.isArray(message.content) ||
		typeof message.timestamp !== "number" ||
		!Number.isFinite(message.timestamp)
	)
		return null;
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		result.invalidatesPreview = true;
		return result;
	}
	const texts: string[] = [];
	for (const block of message.content) {
		if (!isJsonObject(block)) return null;
		if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
		else if (block.type === "thinking" && (typeof block.thinking === "string" || block.redacted === true)) {
			// Private reasoning and signatures never become visible progress.
		} else if (
			block.type === "toolCall" &&
			typeof block.id === "string" &&
			typeof block.name === "string" &&
			isJsonObject(block.arguments)
		) {
			// Tool arguments may contain child replies or arbitrary text.
		} else return null;
	}
	// Pending responses are not persisted by supported Pi; never expose a fabricated one.
	if (message.stopReason === "pending") return null;
	result.text = texts.join("\n\n") || null;
	return result;
}
