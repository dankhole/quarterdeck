import { callLlm } from "./llm-client";

const TITLE_SYSTEM_PROMPT = `Generate a concise 2-4 word title for this coding task.
If an "Agent summary" section is provided, prioritize the LAST entry — it reflects the most recent work.
Capture the core action or outcome, not setup steps.
Return only the title text, nothing else. No quotes, no punctuation at the end.`;

const BRANCH_NAME_SYSTEM_PROMPT =
	"Generate a concise 2-4 word git branch name for this coding task. Use lowercase words separated by hyphens. Return only the branch name, nothing else. No quotes, no slashes, no prefixes. Examples: fix-auth-bug, add-search-filter, refactor-api-client.";

const MAX_PROMPT_LENGTH = 800;

export async function generateTaskTitle(prompt: string): Promise<string | null> {
	return callLlm({
		systemPrompt: TITLE_SYSTEM_PROMPT,
		userPrompt: prompt.slice(0, MAX_PROMPT_LENGTH),
		maxTokens: 20,
		timeoutMs: 3_000,
	});
}

export async function generateBranchName(prompt: string): Promise<string | null> {
	return callLlm({
		systemPrompt: BRANCH_NAME_SYSTEM_PROMPT,
		userPrompt: prompt.slice(0, MAX_PROMPT_LENGTH),
		maxTokens: 20,
		timeoutMs: 3_000,
	});
}
