import { callLlm, DISPLAY_SUMMARY_MAX_LENGTH } from "./llm-client";

const SUMMARY_SYSTEM_PROMPT = `You MUST output at most ${DISPLAY_SUMMARY_MAX_LENGTH} characters. This is a HARD LIMIT — never exceed it.
Write an extremely brief, telegram-style summary of what the agent did. Drop articles, filler words, and unnecessary detail. Use bare verbs. Examples of good output:
- "Added auth middleware and user session validation"
- "Fixed race condition in websocket reconnect logic"
- "Refactored config loading, added env var fallbacks"
Output ONLY the summary text. No quotes, no prefix, no explanation.`;

const MAX_CONTEXT_LENGTH = 2000;

/**
 * Generate a short display summary from conversation summary entries.
 * Returns null on any failure — never throws.
 */
export async function generateDisplaySummary(conversationText: string): Promise<string | null> {
	if (!conversationText.trim()) {
		return null;
	}
	const result = await callLlm({
		systemPrompt: SUMMARY_SYSTEM_PROMPT,
		userPrompt: conversationText.slice(0, MAX_CONTEXT_LENGTH),
		maxTokens: 60,
		timeoutMs: 5_000,
	});
	if (!result) {
		return null;
	}
	// Enforce the max length as a safety net in case the model overshoots.
	return result.length > DISPLAY_SUMMARY_MAX_LENGTH ? `${result.slice(0, DISPLAY_SUMMARY_MAX_LENGTH)}\u2026` : result;
}
