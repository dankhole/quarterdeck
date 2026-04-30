/**
 * Provider-neutral client for lightweight, single-turn completions (titles,
 * branch names, display summaries, commit messages).
 *
 * Preferred environment variables:
 *   QUARTERDECK_LLM_BASE_URL — OpenAI-compatible API base URL
 *   QUARTERDECK_LLM_API_KEY  — bearer token for the endpoint
 *   QUARTERDECK_LLM_MODEL    — model to request from the endpoint
 */

import { createTaggedLogger } from "../core";

const log = createTaggedLogger("llm-client");

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

// ── Response sanitizer ─────────────────────────────────────────────────
// Defense-in-depth: strip common preamble/wrapper patterns even if the
// model ignores the system prompt instructions.

const PREAMBLE_PATTERNS = [
	/^(?:here(?:'s| is)(?: a| the)?|the)\s+(?:title|branch\s*name|summary|commit\s*message|result)\s*(?:is|would be|could be)?[:\-—]\s*/i,
	/^(?:title|branch\s*name|summary|commit\s*message|result)\s*[:\-—]\s*/i,
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

interface LightweightLlmConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

function readEnv(name: string): string | null {
	const value = process.env[name]?.trim();
	return value ? value : null;
}

function resolveLlmConfig(): LightweightLlmConfig | null {
	const model = readEnv("QUARTERDECK_LLM_MODEL");
	const baseUrl = readEnv("QUARTERDECK_LLM_BASE_URL");
	const apiKey = readEnv("QUARTERDECK_LLM_API_KEY");
	if (baseUrl && apiKey && model) {
		return {
			baseUrl,
			apiKey,
			model,
		};
	}

	return null;
}

function resolveChatCompletionsUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "").replace(/\/bedrock$/, "");
	if (trimmed.endsWith("/v1/chat/completions")) {
		return trimmed;
	}
	if (trimmed.endsWith("/v1")) {
		return `${trimmed}/chat/completions`;
	}
	return `${trimmed}/v1/chat/completions`;
}

function isTimeoutError(error: unknown): boolean {
	if (error instanceof DOMException) {
		return error.name === "AbortError" || error.name === "TimeoutError";
	}
	if (error instanceof Error) {
		return error.name === "AbortError" || error.name === "TimeoutError";
	}
	return false;
}

/**
 * Make a single-turn LLM completion call.
 * Returns null on any failure — never throws.
 */
export async function callLlm(options: LlmCallOptions): Promise<string | null> {
	const config = resolveLlmConfig();
	if (!config) {
		return null;
	}

	if (!acquireSlot()) {
		log.warn("Rate limit hit — dropping call", {
			inFlight,
			callsInWindow: callTimestamps.length,
			maxConcurrent: MAX_CONCURRENT,
			maxPerMinute: MAX_PER_MINUTE,
			windowMs: WINDOW_MS,
		});
		return null;
	}

	const startTime = Date.now();
	const timeoutMs = options.timeoutMs ?? 5_000;
	try {
		log.debug("LLM call starting", {
			model: config.model,
			maxTokens: options.maxTokens,
			promptLength: options.userPrompt.length,
		});
		const response = await fetch(resolveChatCompletionsUrl(config.baseUrl), {
			method: "POST",
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				model: config.model,
				max_tokens: options.maxTokens,
				messages: [
					{ role: "system", content: options.systemPrompt },
					{ role: "user", content: options.userPrompt },
				],
			}),
		});

		if (!response.ok) {
			const bodySnippet = await response
				.text()
				.then((t) => t.slice(0, 500))
				.catch(
					(readErr: unknown) =>
						`<failed to read body: ${readErr instanceof Error ? readErr.message : String(readErr)}>`,
				);
			log.warn("LLM call failed: non-2xx response", {
				status: response.status,
				statusText: response.statusText,
				durationMs: Date.now() - startTime,
				model: config.model,
				bodySnippet,
			});
			return null;
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const rawContent = data.choices?.[0]?.message?.content?.trim() || null;
		if (!rawContent) {
			log.warn("LLM call returned empty content", {
				durationMs: Date.now() - startTime,
				model: config.model,
				hasChoices: Array.isArray(data.choices) && data.choices.length > 0,
			});
			return null;
		}
		const result = sanitizeLlmResponse(rawContent);
		if (!result) {
			log.warn("LLM response rejected by sanitizer (looked like a question, refusal, or empty after stripping)", {
				rawContent,
				durationMs: Date.now() - startTime,
				model: config.model,
			});
			return null;
		}
		log.debug("LLM call completed", { durationMs: Date.now() - startTime, resultLength: result.length });
		return result;
	} catch (error) {
		if (isTimeoutError(error)) {
			log.warn("LLM call timed out", {
				timeoutMs,
				durationMs: Date.now() - startTime,
				model: config.model,
			});
		} else {
			log.warn("LLM call error (network or parse failure)", {
				error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
				durationMs: Date.now() - startTime,
				model: config.model,
			});
		}
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
	return resolveLlmConfig() !== null;
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
	resolveChatCompletionsUrl,
	resolveLlmConfig,
};
