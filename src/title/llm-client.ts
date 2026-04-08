/**
 * Shared LLM client for lightweight, single-turn completions via a
 * Bedrock/LiteLLM-compatible proxy.
 *
 * Requires environment variables:
 *   ANTHROPIC_BEDROCK_BASE_URL — proxy URL (e.g. "https://proxy.example.com/bedrock")
 *   ANTHROPIC_AUTH_TOKEN       — bearer token for the proxy
 *
 * Optional:
 *   QUARTERDECK_LLM_MODEL — model override (default: Haiku on Bedrock)
 *   QUARTERDECK_TITLE_MODEL — legacy alias for QUARTERDECK_LLM_MODEL
 */

const DEFAULT_LLM_MODEL = "bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0";

/** Maximum length for the display summary field (shared between LLM prompt and UI truncation). */
export const DISPLAY_SUMMARY_MAX_LENGTH = 80;

interface LlmCallOptions {
	systemPrompt: string;
	userPrompt: string;
	maxTokens: number;
	timeoutMs?: number;
}

/**
 * Make a single-turn LLM completion call.
 * Returns null on any failure — never throws.
 */
export async function callLlm(options: LlmCallOptions): Promise<string | null> {
	const baseUrl = process.env.ANTHROPIC_BEDROCK_BASE_URL;
	const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
	if (!baseUrl || !authToken) {
		return null;
	}

	const model = process.env.QUARTERDECK_LLM_MODEL || process.env.QUARTERDECK_TITLE_MODEL || DEFAULT_LLM_MODEL;

	try {
		const origin = baseUrl.replace(/\/bedrock\/?$/, "");
		const response = await fetch(`${origin}/v1/chat/completions`, {
			method: "POST",
			signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${authToken}`,
			},
			body: JSON.stringify({
				model,
				max_tokens: options.maxTokens,
				messages: [
					{ role: "system", content: options.systemPrompt },
					{ role: "user", content: options.userPrompt },
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

/**
 * Returns true if the LLM client has the required env vars configured.
 * Useful for UI hints about whether LLM features are available.
 */
export function isLlmConfigured(): boolean {
	return Boolean(process.env.ANTHROPIC_BEDROCK_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN);
}
