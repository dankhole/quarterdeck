import { createTaggedLogger } from "../core";
import { callClaude, isClaudeHelperAvailable } from "./claude-client";
import { callCodex, isCodexHelperAvailable } from "./codex-client";
import { callLlm, isLlmConfigured } from "./llm-client";

const log = createTaggedLogger("generation-helper");
const DEFAULT_CLAUDE_TITLE_MODEL = "haiku";

// Each provider's own default call timeout. Codex's and Claude's calls are capped by
// whichever is smaller: this default, or what is left of the caller's own declared
// `timeoutMs` budget once earlier provider attempts in this same chain have spent some of
// it (see remainingBudgetMs/boundedProviderTimeoutMs below). The configured gateway call
// keeps using the caller's original `timeoutMs` unchanged, matching its previous behavior
// exactly (it has no separate "default" to cap against, and decrementing it by elapsed
// wall-clock time would make already-exact tests of its timeout value only approximately
// correct for no benefit).
const CODEX_DEFAULT_TIMEOUT_MS = 20_000;
const CLAUDE_DEFAULT_TIMEOUT_MS = 20_000;
// Below this, a provider attempt is more likely to fail from the timeout itself than from
// anything meaningful, so it is skipped rather than attempted.
const MIN_PROVIDER_TIMEOUT_MS = 500;

/** Milliseconds left of the caller's declared budget. `undefined` means the caller gave no
 * budget, so provider calls are not clamped below their own defaults. */
function remainingBudgetMs(startedAt: number, callerTimeoutMs: number | undefined): number {
	if (callerTimeoutMs === undefined) {
		return Number.POSITIVE_INFINITY;
	}
	return callerTimeoutMs - (Date.now() - startedAt);
}

function boundedProviderTimeoutMs(providerDefaultMs: number, remainingMs: number): number {
	return Math.max(0, Math.min(providerDefaultMs, remainingMs));
}

// codex-client.ts deliberately collapses every Codex failure reason (signed out, timed out,
// network error) into a single `null`, and this workstream does not own that file's return
// contract (other callers depend on its exact `string | null` shape). So instead of asking
// codex-client.ts to classify its own failure, this policy classifies it from the outside by
// timing: a `null` returned well before the timeout given to that call was reached looks like
// a fast launch/auth failure (the shape of a signed-out or misconfigured Codex); a `null`
// returned at (or past) that timeout is indistinguishable from a slow-but-working call (large
// diffs can legitimately use the whole budget) and must not be treated as a failure worth
// backing off. A normalizer/sanitizer rejection of an otherwise-successful (non-null) response
// is also never backoff-eligible. The Codex -> Claude -> gateway chain runs its attempts
// sequentially, so a consistently fast-failing Codex would otherwise cost a fresh attempt on
// every single title/branch/commit-message call. Backing off here (coarser and
// shorter-lived than Claude's own failure-kind backoff, since this classification is coarser)
// bounds that latency. This is latency policy, not correctness: disabling it only makes a
// failing Codex slower to skip past.
const CODEX_FAILURE_BACKOFF_MS = 2 * 60 * 1000;
// A null returned within this fraction of the timeout given to that call is treated as a fast
// failure; closer to the full timeout is treated as indistinguishable from a real timeout.
const CODEX_FAST_FAILURE_FRACTION = 0.9;
let codexFailureBackoffUntil = 0;

function isCodexInFailureBackoff(now: number = Date.now()): boolean {
	return now < codexFailureBackoffUntil;
}

function noteCodexFailure(now: number = Date.now()): void {
	codexFailureBackoffUntil = now + CODEX_FAILURE_BACKOFF_MS;
}

/** Exported for tests only: this module's backoff state is otherwise process-lifetime. */
export function resetGenerationHelperPolicyForTests(): void {
	codexFailureBackoffUntil = 0;
}

type GenerationHelperOptions = Parameters<typeof callLlm>[0] & {
	/** Selects where the Codex -> Claude -> gateway chain starts; every provider still falls
	 * through to the configured gateway as a final fallback. `codex` (the default) tries
	 * Codex, then Claude, then the gateway. `claude` skips Codex and tries Claude, then the
	 * gateway. `llm` skips both saved-login providers and uses only the gateway. */
	provider?: "codex" | "claude" | "llm";
	codexModel?: string;
	claudeModel?: string;
	normalize?: (text: string | null) => string | null;
};

/** True when at least one provider in the default Codex-then-Claude-then-gateway policy can be
 * attempted. A PATH-only check: a provider temporarily backed off after a recent failure is
 * still "available" in the sense this flag reports, since the backoff is call-latency policy,
 * not a fact about whether the provider is configured. */
export function isGenerationHelperAvailable(): boolean {
	return isCodexHelperAvailable() || isClaudeHelperAvailable() || isLlmConfigured();
}

/** Shared provider policy: saved Codex login first, saved Claude login second, configured gateway last.
 * An explicit `provider` selects where the chain starts; every provider still falls through to the
 * configured gateway as a final fallback. Each provider's own call is capped by whatever is left of
 * the caller's declared `timeoutMs` budget, so a slow or backed-off earlier attempt cannot silently
 * multiply the total latency a caller is prepared to wait. */
export async function callGenerationHelper(options: GenerationHelperOptions): Promise<string | null> {
	const normalize = options.normalize ?? ((text: string | null) => text);
	const startedAt = Date.now();
	const callerTimeoutMs = options.timeoutMs;

	if (options.provider !== "llm" && options.provider !== "claude") {
		if (isCodexInFailureBackoff()) {
			log.debug("Codex helper call skipped: backing off after a recent failure");
		} else {
			const remaining = remainingBudgetMs(startedAt, callerTimeoutMs);
			if (remaining < MIN_PROVIDER_TIMEOUT_MS) {
				log.debug("Codex helper call skipped: caller budget exhausted");
			} else {
				const codexTimeoutMs = boundedProviderTimeoutMs(CODEX_DEFAULT_TIMEOUT_MS, remaining);
				const codexStartedAt = Date.now();
				const codexRawResult = await callCodex({
					systemPrompt: options.systemPrompt,
					userPrompt: options.userPrompt,
					model: options.codexModel ?? "gpt-6-luna",
					timeoutMs: codexTimeoutMs,
				});
				if (codexRawResult === null) {
					const codexElapsedMs = Date.now() - codexStartedAt;
					if (codexElapsedMs < codexTimeoutMs * CODEX_FAST_FAILURE_FRACTION) {
						noteCodexFailure();
					}
				}
				const result = normalize(codexRawResult);
				if (result) return result;
			}
		}
	}
	if (options.provider !== "llm") {
		const remaining = remainingBudgetMs(startedAt, callerTimeoutMs);
		if (remaining < MIN_PROVIDER_TIMEOUT_MS) {
			log.debug("Claude helper call skipped: caller budget exhausted");
		} else {
			const result = normalize(
				await callClaude({
					systemPrompt: options.systemPrompt,
					userPrompt: options.userPrompt,
					model: options.claudeModel ?? DEFAULT_CLAUDE_TITLE_MODEL,
					timeoutMs: boundedProviderTimeoutMs(CLAUDE_DEFAULT_TIMEOUT_MS, remaining),
				}),
			);
			if (result) return result;
		}
	}
	return normalize(
		await callLlm({
			systemPrompt: options.systemPrompt,
			userPrompt: options.userPrompt,
			maxTokens: options.maxTokens,
			timeoutMs: options.timeoutMs,
		}),
	);
}
