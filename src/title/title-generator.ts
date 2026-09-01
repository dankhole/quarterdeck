// Lightweight generation for titles and branch names. Title generation uses
// one selected remote provider plus a deterministic local fallback. Branch
// names remain LLM-only because a bad branch name is more costly than a bad
// card label.
import { createTaggedLogger } from "../core";
import { callCodex } from "./codex-client";
import { callLlm, isLlmConfigured } from "./llm-client";
import { createFallbackTaskTitle, normalizeGeneratedTitle } from "./title-fallback";

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

const MAX_TITLE_CONTEXT_LENGTH = 1200;
const MAX_BRANCH_PROMPT_LENGTH = 1200;
const CODEX_TITLE_GENERATION_TIMEOUT_MS = 20_000;
const TITLE_GENERATION_TIMEOUT_MS = 6_000;
const DEFAULT_CODEX_TITLE_MODEL = "gpt-5.6-luna";

type TitleProvider = "codex" | "llm" | "local";

function resolveTitleProvider(): TitleProvider {
	const configured = process.env.QUARTERDECK_TITLE_PROVIDER?.trim().toLowerCase();
	if (!configured || configured === "local") {
		return "local";
	}
	if (configured === "codex" || configured === "llm") {
		return configured;
	}
	log.warn("Ignoring unsupported QUARTERDECK_TITLE_PROVIDER value", {
		configured,
		fallbackProvider: "local",
		supportedProviders: ["codex", "llm", "local"],
	});
	return "local";
}

function resolveCodexTitleModel(): string {
	return process.env.QUARTERDECK_CODEX_TITLE_MODEL?.trim() || DEFAULT_CODEX_TITLE_MODEL;
}

function normalizeTitle(title: string | null): string | null {
	return title ? normalizeGeneratedTitle(title) : null;
}

export async function generateTaskTitle(prompt: string): Promise<string | null> {
	const titleProvider = resolveTitleProvider();
	const llmConfigured = isLlmConfigured();
	log.debug("Generating task title", {
		promptLength: prompt.length,
		promptSnippet: prompt.slice(0, 100),
		titleProvider,
		llmConfigured,
	});
	if (prompt.trim().length === 0) {
		log.warn("Title generation skipped: prompt is empty after trim");
		return null;
	}

	const titleContext = prompt.slice(0, MAX_TITLE_CONTEXT_LENGTH);
	if (titleProvider === "codex") {
		const codexTitle = normalizeTitle(
			await callCodex({
				systemPrompt: TITLE_SYSTEM_PROMPT,
				userPrompt: titleContext,
				timeoutMs: CODEX_TITLE_GENERATION_TIMEOUT_MS,
				model: resolveCodexTitleModel(),
			}),
		);
		if (codexTitle) {
			log.info("Title generated", { title: codexTitle, provider: "codex" });
			return codexTitle;
		}
	} else if (titleProvider === "llm" && llmConfigured) {
		const llmTitle = normalizeTitle(
			await callLlm({
				systemPrompt: TITLE_SYSTEM_PROMPT,
				userPrompt: titleContext,
				maxTokens: 20,
				timeoutMs: TITLE_GENERATION_TIMEOUT_MS,
			}),
		);
		if (llmTitle) {
			log.info("Title generated", { title: llmTitle, provider: "llm" });
			return llmTitle;
		}
	}

	const fallbackTitle = createFallbackTaskTitle(prompt);
	if (titleProvider === "local") {
		log.debug("Title generated", { title: fallbackTitle, provider: "local" });
		return fallbackTitle;
	}
	log.warn("Remote title generation unavailable — using prompt-derived fallback", {
		promptLength: prompt.length,
		promptSnippet: prompt.slice(0, 100),
		titleProvider,
		llmConfigured,
		fallbackTitle,
	});
	return fallbackTitle;
}

export async function generateBranchName(prompt: string): Promise<string | null> {
	return callLlm({
		systemPrompt: BRANCH_NAME_SYSTEM_PROMPT,
		userPrompt: prompt.slice(0, MAX_BRANCH_PROMPT_LENGTH),
		maxTokens: 20,
		timeoutMs: 5_000,
	});
}
