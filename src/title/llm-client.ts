/**
 * Provider-neutral client for lightweight, single-turn completions (titles,
 * branch names, display summaries, commit messages).
 *
 * Preferred environment variables:
 *   QUARTERDECK_LLM_BASE_URL — OpenAI-compatible API base URL
 *   QUARTERDECK_LLM_API_KEY  — bearer token for the endpoint
 *   QUARTERDECK_LLM_MODEL    — optional model override
 */

import { createTaggedLogger } from "../core";
import { sanitizeGenerationResponse } from "./generation-response";

const log = createTaggedLogger("llm-client");
const DEFAULT_LLM_MODEL = "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";

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

interface RetiredModelReplacement {
	replacementModel: string;
	reason: string;
}

const RETIRED_MODEL_REPLACEMENTS: Record<string, RetiredModelReplacement> = {
	"bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0": {
		replacementModel: "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
		reason: "Claude 3.5 Haiku reached Bedrock EOL; Claude Haiku 4.5 is the current low-latency replacement.",
	},
	"us.anthropic.claude-3-5-haiku-20241022-v1:0": {
		replacementModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		reason: "Claude 3.5 Haiku reached Bedrock EOL; Claude Haiku 4.5 is the current low-latency replacement.",
	},
	"anthropic.claude-3-5-haiku-20241022-v1:0": {
		replacementModel: "anthropic.claude-haiku-4-5-20251001-v1:0",
		reason: "Claude 3.5 Haiku reached Bedrock EOL; Claude Haiku 4.5 is the current low-latency replacement.",
	},
	"claude-3-5-haiku-20241022": {
		replacementModel: "claude-haiku-4-5-20251001",
		reason: "Claude 3.5 Haiku is retired; Claude Haiku 4.5 is the current low-latency replacement.",
	},
};

function readEnv(name: string): string | null {
	const value = process.env[name]?.trim();
	return value ? value : null;
}

function resolveLlmConfig(): LightweightLlmConfig | null {
	const baseUrl = readEnv("QUARTERDECK_LLM_BASE_URL");
	const apiKey = readEnv("QUARTERDECK_LLM_API_KEY");
	if (baseUrl && apiKey) {
		return {
			baseUrl,
			apiKey,
			model: readEnv("QUARTERDECK_LLM_MODEL") ?? DEFAULT_LLM_MODEL,
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

function resolveRetiredModelReplacement(model: string): RetiredModelReplacement | null {
	return RETIRED_MODEL_REPLACEMENTS[model] ?? null;
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
			const retiredModelReplacement = resolveRetiredModelReplacement(config.model);
			log.warn("LLM call failed: non-2xx response", {
				status: response.status,
				statusText: response.statusText,
				durationMs: Date.now() - startTime,
				model: config.model,
				bodySnippet,
				...(retiredModelReplacement
					? {
							modelReplacementHint: `Set QUARTERDECK_LLM_MODEL=${retiredModelReplacement.replacementModel}`,
							replacementModel: retiredModelReplacement.replacementModel,
							replacementReason: retiredModelReplacement.reason,
						}
					: {}),
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
		const result = sanitizeGenerationResponse(rawContent);
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
 * Returns true if the LLM client has the required endpoint and auth env vars configured.
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
	DEFAULT_LLM_MODEL,
	resolveRetiredModelReplacement,
	resolveChatCompletionsUrl,
	resolveLlmConfig,
};
