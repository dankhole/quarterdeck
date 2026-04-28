/**
 * Parse a Claude Code transcript JSONL file and extract the last meaningful
 * assistant message. Skips tool call acknowledgments, tool results, and
 * system messages.
 *
 * The Claude Code transcript format (as of 2026-04) uses one JSON object per
 * line. Each object has at minimum a `type` field. Assistant text messages have:
 *   { "type": "assistant", "message": { "role": "assistant", "content": [...] } }
 * where content items with type "text" contain the actual message text.
 *
 * Tool use entries have content items with type "tool_use" and should be
 * skipped when looking for meaningful text messages.
 *
 * NOTE: This format is internal to Claude Code and may change. If parsing
 * fails, return null gracefully - never throw.
 *
 * --- Future: Multi-agent transcript enrichment ---
 * If another agent later needs transcript-side enrichment, create a shared interface:
 *   interface TranscriptParser {
 *     extractLastAssistantMessage(filePath: string): Promise<string | null>;
 *   }
 * with per-agent implementations.
 */
import { open } from "node:fs/promises";

interface TranscriptContentItem {
	type: string;
	text?: string;
}

interface TranscriptMessage {
	role?: string;
	content?: TranscriptContentItem[] | string;
}

interface TranscriptLine {
	type?: string;
	message?: TranscriptMessage;
}

const DEFAULT_TAIL_LINE_LIMIT = 50;
const DEFAULT_TAIL_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TAIL_BYTE_LIMIT = 1024 * 1024;
const NEWLINE_BYTE = "\n".charCodeAt(0);

async function readTranscriptTailLines(
	transcriptPath: string,
	maxLines = DEFAULT_TAIL_LINE_LIMIT,
	maxBytes = DEFAULT_TAIL_BYTE_LIMIT,
): Promise<string[]> {
	const handle = await open(transcriptPath, "r");
	try {
		const { size } = await handle.stat();
		if (size === 0 || maxLines <= 0 || maxBytes <= 0) {
			return [];
		}

		const chunks: Buffer[] = [];
		let position = size;
		let bytesCollected = 0;
		let newlineCount = 0;

		while (position > 0 && newlineCount <= maxLines && bytesCollected < maxBytes) {
			const bytesToRead = Math.min(DEFAULT_TAIL_CHUNK_BYTES, position, maxBytes - bytesCollected);
			position -= bytesToRead;
			const buffer = Buffer.allocUnsafe(bytesToRead);
			const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
			if (bytesRead <= 0) {
				break;
			}
			const chunk = buffer.subarray(0, bytesRead);
			chunks.unshift(chunk);
			bytesCollected += bytesRead;
			for (const byte of chunk) {
				if (byte === NEWLINE_BYTE) {
					newlineCount += 1;
				}
			}
		}

		const rawLines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
		if (position > 0) {
			rawLines.shift();
		}
		return rawLines.filter((line) => line.trim().length > 0).slice(-maxLines);
	} finally {
		await handle.close();
	}
}

/**
 * Extract text content from an assistant message's content array.
 * Returns concatenated text items, or null if no meaningful text found.
 */
function extractTextFromContent(content: TranscriptContentItem[] | string | undefined): string | null {
	if (typeof content === "string") {
		return content.trim() || null;
	}
	if (!Array.isArray(content)) {
		return null;
	}
	const textParts: string[] = [];
	for (const item of content) {
		if (item.type === "text" && typeof item.text === "string") {
			const trimmed = item.text.trim();
			if (trimmed) {
				textParts.push(trimmed);
			}
		}
	}
	return textParts.length > 0 ? textParts.join(" ") : null;
}

/**
 * Check if a message contains any tool_use content items.
 */
function hasToolUse(content: TranscriptContentItem[] | string | undefined): boolean {
	if (!Array.isArray(content)) {
		return false;
	}
	return content.some((item) => item.type === "tool_use");
}

/**
 * Parse a Claude Code transcript JSONL file and extract the last meaningful
 * assistant message text.
 *
 * Reads the file and processes only the last 50 non-empty lines. Iterates
 * backwards to find the most recent assistant message with meaningful text content.
 *
 * A message is considered "not meaningful" if:
 * - It has no text content items
 * - Its text is <30 chars AND the message also contains a tool_use item
 *   (likely a preamble to a tool call, not a real summary)
 *
 * Returns the extracted text capped at 500 chars, or null on any error.
 */
export async function extractLastAssistantMessage(transcriptPath: string): Promise<string | null> {
	try {
		const lines = await readTranscriptTailLines(transcriptPath);

		for (let i = lines.length - 1; i >= 0; i--) {
			let parsed: TranscriptLine;
			try {
				parsed = JSON.parse(lines[i]) as TranscriptLine;
			} catch {
				continue;
			}

			if (parsed.type !== "assistant") {
				continue;
			}

			const message = parsed.message;
			if (!message || message.role !== "assistant") {
				continue;
			}

			const text = extractTextFromContent(message.content);
			if (!text) {
				continue;
			}

			// Skip short text that accompanies tool_use (likely a preamble like "I'll read that file").
			if (text.length < 30 && hasToolUse(message.content)) {
				continue;
			}

			// Cap at 500 chars.
			return text.length > 500 ? `${text.slice(0, 500)}\u2026` : text;
		}

		return null;
	} catch {
		return null;
	}
}
