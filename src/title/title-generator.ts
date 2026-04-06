const TITLE_SYSTEM_PROMPT =
	"Generate a concise 2-4 word title for this coding task. Return only the title text, nothing else. No quotes, no punctuation at the end.";

const DEFAULT_TITLE_MODEL = "bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0";
const titleModel = process.env.KANBAN_TITLE_MODEL || DEFAULT_TITLE_MODEL;

/**
 * Generate a short task title from a prompt via the Bedrock/LiteLLM proxy.
 * Requires ANTHROPIC_BEDROCK_BASE_URL + ANTHROPIC_AUTH_TOKEN env vars.
 * Returns null on any failure — never throws.
 */
const MAX_PROMPT_LENGTH = 500;

export async function generateTaskTitle(prompt: string): Promise<string | null> {
	prompt = prompt.slice(0, MAX_PROMPT_LENGTH);
	const baseUrl = process.env.ANTHROPIC_BEDROCK_BASE_URL;
	const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
	if (!baseUrl || !authToken) {
		return null;
	}

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
					{ role: "system", content: TITLE_SYSTEM_PROMPT },
					{ role: "user", content: prompt },
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
