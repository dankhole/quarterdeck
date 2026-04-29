// Lightweight generation for titles and branch names. Titles degrade to a
// deterministic prompt-derived fallback when the helper LLM is unavailable or
// slow; branch names remain LLM-only because a bad branch name is more costly
// than a bad card label.
import { createTaggedLogger } from "../core";
import { callLlm, isLlmConfigured } from "./llm-client";
import { createFallbackTaskTitle, normalizeGeneratedTitle } from "./title-fallback";

const log = createTaggedLogger("title-gen");
const TITLE_SYSTEM_PROMPT = `Generate a concise 2-4 word title for this coding task.
Focus on the MOST RECENT activity — it reflects what the task actually accomplished. Earlier context and the original prompt are background; the latest work is what matters for the title.
Capture the core action or outcome, not setup steps.

CRITICAL RULES:
- Output ONLY the title text. Nothing else.
- No quotes, no punctuation at the end, no prefix like "Title:" or "Here's a title:".
- NEVER ask a question, request clarification, or say you need more information.
- NEVER refuse. NEVER say "I can't" or "I'm not sure".
- If the input is unclear, vague, or empty, generate your best guess anyway — a bad title is better than a non-title response.
- Your entire response must be the title and nothing else.`;

const BRANCH_NAME_SYSTEM_PROMPT = `Generate a concise 2-4 word git branch name for this coding task. Use lowercase words separated by hyphens. Examples: fix-auth-bug, add-search-filter, refactor-api-client.

CRITICAL RULES:
- Output ONLY the branch name. Nothing else.
- No quotes, no slashes, no prefixes like "Branch:" or "Here's a branch name:".
- NEVER ask a question, request clarification, or say you need more information.
- NEVER refuse. NEVER say "I can't" or "I'm not sure".
- If the input is unclear, vague, or empty, generate your best guess anyway — a bad branch name is better than a non-branch-name response.
- Your entire response must be the branch name and nothing else.`;

const MAX_TITLE_CONTEXT_LENGTH = 1200;
const MAX_BRANCH_PROMPT_LENGTH = 1200;

export async function generateTaskTitle(prompt: string): Promise<string | null> {
	const llmConfigured = isLlmConfigured();
	log.debug("Generating task title", {
		promptLength: prompt.length,
		promptSnippet: prompt.slice(0, 100),
		llmConfigured,
	});
	if (!llmConfigured) {
		log.warn(
			"Title generation using fallback: LLM not configured (set QUARTERDECK_LLM_BASE_URL, QUARTERDECK_LLM_API_KEY, and QUARTERDECK_LLM_MODEL)",
		);
		return createFallbackTaskTitle(prompt);
	}
	if (prompt.trim().length === 0) {
		log.warn("Title generation skipped: prompt is empty after trim");
		return null;
	}
	const title = await callLlm({
		systemPrompt: TITLE_SYSTEM_PROMPT,
		userPrompt: prompt.slice(0, MAX_TITLE_CONTEXT_LENGTH),
		maxTokens: 20,
		timeoutMs: 5_000,
	});
	if (title) {
		const normalizedTitle = normalizeGeneratedTitle(title);
		if (normalizedTitle) {
			log.info("Title generated", { title: normalizedTitle });
			return normalizedTitle;
		}
	}
	const fallbackTitle = createFallbackTaskTitle(prompt);
	log.warn(
		"Title generation returned null — using prompt-derived fallback; see preceding 'llm-client' log for cause (rate limit, HTTP error, timeout, empty content, or sanitizer rejection)",
		{ promptLength: prompt.length, promptSnippet: prompt.slice(0, 100), fallbackTitle },
	);
	return fallbackTitle;
}

export async function generateBranchName(prompt: string): Promise<string | null> {
	return callLlm({
		systemPrompt: BRANCH_NAME_SYSTEM_PROMPT,
		userPrompt: prompt.slice(0, MAX_BRANCH_PROMPT_LENGTH),
		maxTokens: 20,
		timeoutMs: 5_000,
	});
}
