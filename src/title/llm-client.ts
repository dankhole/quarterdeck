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

import { createTaggedLogger } from "../core/debug-logger";

const log = createTaggedLogger("llm-client");
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
	while (callTimestamps.length > 0 && (callTimestamps[0] ?? 0) < now - WINDOW_MS) {
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

// ── Response sanitizer ─────────────────────────────────────────────────
// Defense-in-depth: strip common preamble/wrapper patterns even if the
// model ignores the system prompt instructions.

const PREAMBLE_PATTERNS = [
	/^(?:here(?:'s| is)(?: a| the)?|the)\s+(?:title|branch\s*name|summary|result)\s*(?:is|would be|could be)?[:\-—]\s*/i,
	/^(?:title|branch\s*name|summary|result)\s*[:\-—]\s*/i,
	/^(?:sure|okay|of course|certainly|absolutely)[!,.]?\s*(?:here(?:'s| is))?[:\-—]?\s*/i,
];

/** Trailing question marks or "let me know" style suffixes. */
const TRAILING_NOISE =
	/\s*(?:let me know.*|is that (?:ok|okay|good|helpful).*|would you like.*|do you want.*|shall i.*)\s*[?.!]*$/i;

/**
 * Strip preamble, trailing noise, and outer quotes from an LLM response.
 * Returns null if the result looks like a question or refusal rather than
 * the requested content.
 */
export function sanitizeLlmResponse(raw: string): string | null {
	let text = raw.trim();

	// Strip outer quotes (single or double).
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}

	// Strip known preamble patterns.
	for (const pattern of PREAMBLE_PATTERNS) {
		text = text.replace(pattern, "");
	}

	// Strip quotes again — preamble removal may have exposed them (e.g. 'Title: "Fix Bug"').
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}

	// Strip trailing conversational noise.
	text = text.replace(TRAILING_NOISE, "").trim();

	// If the entire response is a question or refusal, reject it.
	if (
		/^(?:i (?:can't|cannot|couldn't|don't|need|would need)|what |which |could you|can you|please (?:provide|clarify))/i.test(
			text,
		)
	) {
		return null;
	}

	return text || null;
}

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
		log.warn("Rate limit hit — dropping call");
		return null;
	}

	try {
		const model = process.env.QUARTERDECK_LLM_MODEL || process.env.QUARTERDECK_TITLE_MODEL || DEFAULT_LLM_MODEL;
		const startTime = Date.now();
		log.debug("LLM call starting", { model, maxTokens: options.maxTokens, promptLength: options.userPrompt.length });
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
			log.warn("LLM call failed", { status: response.status, durationMs: Date.now() - startTime });
			return null;
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const rawContent = data.choices?.[0]?.message?.content?.trim() || null;
		if (!rawContent) {
			log.warn("LLM call returned empty content", { durationMs: Date.now() - startTime });
			return null;
		}
		const result = sanitizeLlmResponse(rawContent);
		if (!result) {
			log.warn("LLM response rejected by sanitizer", { rawContent, durationMs: Date.now() - startTime });
			return null;
		}
		log.debug("LLM call completed", { durationMs: Date.now() - startTime, resultLength: result.length });
		return result;
	} catch (error) {
		log.warn("LLM call error", { error: error instanceof Error ? error.message : String(error) });
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
