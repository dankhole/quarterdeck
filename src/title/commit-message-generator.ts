// Commit message generation from git diffs. Uses the same LLM client as
// title and summary generation — see llm-client.ts for setup requirements.
// When LLM is not configured, returns null and the UI stays manual-only.
import { createTaggedLogger } from "../core/debug-logger";
import { callLlm } from "./llm-client";

const log = createTaggedLogger("commit-msg-gen");

const COMMIT_MESSAGE_SYSTEM_PROMPT = `Generate a concise git commit message from the provided diff.
Write a short summary line (max 72 characters) in imperative mood (e.g. "fix", "add", "refactor", not "fixed", "added", "refactored").
If the changes are non-trivial, add a blank line followed by 1-3 bullet points describing the key changes.

CRITICAL RULES:
- Output ONLY the commit message. Nothing else.
- No quotes, no prefix like "Commit message:" or "Here's a commit message:".
- NEVER ask a question, request clarification, or say you need more information.
- NEVER refuse. NEVER say "I can't" or "I'm not sure".
- If the diff is unclear or empty, generate your best guess anyway.
- Your entire response must be the commit message and nothing else.
- Focus on WHAT changed and WHY, not listing every file.`;

const MAX_DIFF_LENGTH = 3000;

/**
 * Generate a commit message from a git diff string.
 * Returns null on any failure — never throws.
 */
export async function generateCommitMessage(diff: string): Promise<string | null> {
	if (!diff.trim()) {
		return null;
	}
	log.debug("Generating commit message", { diffLength: diff.length, diffSnippet: diff.slice(0, 120) });
	const result = await callLlm({
		systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
		userPrompt: diff.slice(0, MAX_DIFF_LENGTH),
		maxTokens: 150,
		timeoutMs: 7_000,
	});
	if (!result) {
		log.warn("Commit message generation returned null");
		return null;
	}
	log.info("Commit message generated", { message: result });
	return result;
}
