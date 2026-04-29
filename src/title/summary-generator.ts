// Optional LLM display summary generation. The board does not trigger this on
// hover; normal card summaries use compact agent-provided conversation text.
import { createTaggedLogger } from "../core";
import { compactDisplaySummaryText, DISPLAY_SUMMARY_LLM_BUDGET } from "./display-summary";
import { callLlm } from "./llm-client";

const log = createTaggedLogger("summary-gen");

const SUMMARY_SYSTEM_PROMPT = `You MUST output at most ${DISPLAY_SUMMARY_LLM_BUDGET} characters. This is a HARD LIMIT — never exceed it.
Write an extremely brief, telegram-style summary of what the agent did. Drop articles, filler words, and unnecessary detail. Use bare verbs. Examples of good output:
- "Added auth middleware and user session validation"
- "Fixed race condition in websocket reconnect logic"
- "Refactored config loading, added env var fallbacks"

CRITICAL RULES:
- Output ONLY the summary text. Nothing else.
- No quotes, no prefix like "Summary:" or "Here's a summary:", no explanation.
- NEVER ask a question, request clarification, or say you need more information.
- NEVER refuse. NEVER say "I can't" or "I'm not sure".
- If the input is unclear, vague, or empty, generate your best guess anyway — a bad summary is better than a non-summary response.
- Your entire response must be the summary and nothing else.`;

const MAX_CONTEXT_LENGTH = 1800;

/**
 * Generate a short display summary from conversation summary entries.
 * Returns null on any failure — never throws.
 */
export async function generateDisplaySummary(conversationText: string): Promise<string | null> {
	if (!conversationText.trim()) {
		return null;
	}
	log.debug("Generating display summary", {
		textLength: conversationText.length,
		textSnippet: conversationText.slice(0, 120),
	});
	const result = await callLlm({
		systemPrompt: SUMMARY_SYSTEM_PROMPT,
		userPrompt: conversationText.slice(0, MAX_CONTEXT_LENGTH),
		maxTokens: 60,
		timeoutMs: 5_000,
	});
	if (!result) {
		log.warn("Summary generation returned null");
		return null;
	}
	const summary = compactDisplaySummaryText(result);
	if (!summary) {
		log.warn("Summary generation produced empty compact summary");
		return null;
	}
	log.info("Summary generated", { summary });
	return summary;
}
