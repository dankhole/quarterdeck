/**
 * Shared LLM client for lightweight, single-turn completions (titles, branch
 * names, display summaries).
 *
 * SETUP-SPECIFIC: This currently assumes a Bedrock/LiteLLM-compatible proxy
 * with Anthropic-specific env vars and a Haiku default model. It should be
 * made portable — support arbitrary OpenAI-compatible endpoints, direct API
 * keys for multiple providers, or a config-driven model selection — so that
 * LLM generation features work regardless of which agent provider a user has
 * configured. See planned-features.md for context.
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

// ── Rate limiter ────────────────────────────────────────────────────────
// Guards against runaway API costs from bugs or rapid state transitions.
// When a limit is hit, callLlm returns null — all callers already handle this.
const MAX_CONCURRENT = 5;
const MAX_PER_MINUTE = 20;
const WINDOW_MS = 60_000;

let inFlight = 0;
const callTimestamps: number[] = [];

function acquireSlot(): boolean {
	const now = Date.now();
	// Prune timestamps outside the rolling window.
	while (callTimestamps.length > 0 && callTimestamps[0]! < now - WINDOW_MS) {
		callTimestamps.shift();
	}
	if (inFlight >= MAX_CONCURRENT || callTimestamps.length >= MAX_PER_MINUTE) {
		return false;
	}
	inFlight++;
	callTimestamps.push(now);
	return true;
}

function releaseSlot(): void {
	inFlight = Math.max(0, inFlight - 1);
}

/** Hard display limit — summaries longer than this are truncated with an ellipsis. */
export const DISPLAY_SUMMARY_MAX_LENGTH = 90;

/**
 * Character budget given to the LLM in the system prompt. Set lower than
 * DISPLAY_SUMMARY_MAX_LENGTH so the model's natural overshoot still lands
 * within the display limit without needing a hard truncation.
 */
export const DISPLAY_SUMMARY_LLM_BUDGET = 75;

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

	if (!acquireSlot()) {
		console.warn("[llm-client] Rate limit hit — dropping call");
		return null;
	}

	try {
		const model = process.env.QUARTERDECK_LLM_MODEL || process.env.QUARTERDECK_TITLE_MODEL || DEFAULT_LLM_MODEL;
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
	} finally {
		releaseSlot();
	}
}

/**
 * Returns true if the LLM client has the required env vars configured.
 * Useful for UI hints about whether LLM features are available.
 */
export function isLlmConfigured(): boolean {
	return Boolean(process.env.ANTHROPIC_BEDROCK_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN);
}

// ── Test helpers ────────────────────────────────────────────────────────
// Exported exclusively for unit tests. Not part of the public API.

/** @internal */
export const _testing = {
	acquireSlot,
	releaseSlot,
	resetRateLimiter(): void {
		inFlight = 0;
		callTimestamps.length = 0;
	},
	get inFlight() {
		return inFlight;
	},
	get callTimestamps() {
		return callTimestamps;
	},
	MAX_CONCURRENT,
	MAX_PER_MINUTE,
	WINDOW_MS,
};
