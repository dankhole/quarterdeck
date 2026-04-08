const TITLE_SYSTEM_PROMPT =
	"Generate a concise 2-4 word title for this coding task. Return only the title text, nothing else. No quotes, no punctuation at the end.";

const BRANCH_NAME_SYSTEM_PROMPT =
	"Generate a concise 2-4 word git branch name for this coding task. Use lowercase words separated by hyphens. Return only the branch name, nothing else. No quotes, no slashes, no prefixes. Examples: fix-auth-bug, add-search-filter, refactor-api-client.";

const DEFAULT_TITLE_MODEL = "bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0";

/**
 * Generate a short task title from a prompt via the Bedrock/LiteLLM proxy.
 * Requires ANTHROPIC_BEDROCK_BASE_URL + ANTHROPIC_AUTH_TOKEN env vars.
 *
 * ANTHROPIC_BEDROCK_BASE_URL is expected to end with `/bedrock` (e.g.
 * "https://proxy.example.com/bedrock"). The `/bedrock` suffix is stripped
 * to derive the origin for the OpenAI-compatible `/v1/chat/completions`
 * endpoint. If the URL doesn't end with `/bedrock`, it's used as-is.
 *
 * Returns null on any failure — never throws.
 */
const MAX_PROMPT_LENGTH = 500;

async function callLlm(systemPrompt: string, userPrompt: string): Promise<string | null> {
	const truncatedPrompt = userPrompt.slice(0, MAX_PROMPT_LENGTH);
	const baseUrl = process.env.ANTHROPIC_BEDROCK_BASE_URL;
	const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
	if (!baseUrl || !authToken) {
		return null;
	}

	const titleModel = process.env.QUARTERDECK_TITLE_MODEL || DEFAULT_TITLE_MODEL;

	try {
		const origin = baseUrl.replace(/\/bedrock\/?$/, "");
		const response = await fetch(`${origin}/v1/chat/completions`, {
			method: "POST",
			signal: AbortSignal.timeout(3_000),
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${authToken}`,
			},
			body: JSON.stringify({
				model: titleModel,
				max_tokens: 20,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: truncatedPrompt },
				],
			}),
		});

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		return data.choices?.[0]?.message?.content?.trim() || null;
	} catch {
		return null;
	}
}

export async function generateTaskTitle(prompt: string): Promise<string | null> {
	return await callLlm(TITLE_SYSTEM_PROMPT, prompt);
}

export async function generateBranchName(prompt: string): Promise<string | null> {
	return await callLlm(BRANCH_NAME_SYSTEM_PROMPT, prompt);
}
