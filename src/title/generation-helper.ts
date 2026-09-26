import { callCodex, isCodexHelperAvailable } from "./codex-client";
import { callLlm, isLlmConfigured } from "./llm-client";

type GenerationHelperOptions = Parameters<typeof callLlm>[0] & {
	provider?: "codex" | "llm";
	codexModel?: string;
	normalize?: (text: string | null) => string | null;
};

/** True when at least one provider in the default Codex-then-gateway policy can be attempted. */
export function isGenerationHelperAvailable(): boolean {
	return isCodexHelperAvailable() || isLlmConfigured();
}

/** Shared provider policy: saved Codex login first, configured gateway second. */
export async function callGenerationHelper(options: GenerationHelperOptions): Promise<string | null> {
	const normalize = options.normalize ?? ((text: string | null) => text);
	if (options.provider !== "llm") {
		const result = normalize(
			await callCodex({
				systemPrompt: options.systemPrompt,
				userPrompt: options.userPrompt,
				model: options.codexModel ?? "gpt-6-luna",
				timeoutMs: 20_000,
			}),
		);
		if (result) return result;
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
