// LLM generation for titles and branch names. Currently requires a
// setup-specific Bedrock proxy — see llm-client.ts for portability notes.
// When LLM is not configured, these return null and callers fall back
// gracefully (cards show truncated prompt text, branch name field stays empty).
import { createTaggedLogger } from "../core/runtime-logger";
import { callLlm } from "./llm-client";

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

const MAX_PROMPT_LENGTH = 1600;

export async function generateTaskTitle(prompt: string): Promise<string | null> {
	log.debug("Generating task title", { promptLength: prompt.length, promptSnippet: prompt.slice(0, 100) });
	const title = await callLlm({
		systemPrompt: TITLE_SYSTEM_PROMPT,
		userPrompt: prompt.slice(0, MAX_PROMPT_LENGTH),
		maxTokens: 20,
		timeoutMs: 5_000,
	});
	if (title) {
		log.info("Title generated", { title });
	} else {
		log.warn("Title generation returned null");
	}
	return title;
}

export async function generateBranchName(prompt: string): Promise<string | null> {
	return callLlm({
		systemPrompt: BRANCH_NAME_SYSTEM_PROMPT,
		userPrompt: prompt.slice(0, MAX_PROMPT_LENGTH),
		maxTokens: 20,
		timeoutMs: 5_000,
	});
}
