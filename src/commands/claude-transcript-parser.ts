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
 * --- Future: Codex Integration ---
 * Codex transcripts use a different JSONL format (see codex-hook-events.ts).
 * When unifying enrichment, create a shared interface:
 *   interface TranscriptParser {
 *     extractLastAssistantMessage(filePath: string): Promise<string | null>;
 *   }
 * with per-agent implementations (ClaudeTranscriptParser, CodexTranscriptParser).
 */
import { readFile } from "node:fs/promises";

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
		const raw = await readFile(transcriptPath, "utf8");
		const allLines = raw.split("\n").filter((line) => line.trim().length > 0);
		const lines = allLines.slice(-50);

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
			// Cap at 500 chars.
			return text.length > 500 ? `${text.slice(0, 500)}\u2026` : text;
		}

		return null;
	} catch {
		return null;
	}
}
