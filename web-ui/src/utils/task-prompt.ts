export const DEFAULT_TASK_PROMPT_LABEL_MAX_CHARS = 100;

function normalizePromptForDisplay(prompt: string): string {
	return prompt.replaceAll(/\s+/g, " ").trim();
}

export function truncateTaskPromptLabel(prompt: string, maxChars = DEFAULT_TASK_PROMPT_LABEL_MAX_CHARS): string {
	if (maxChars <= 0) {
		return "";
	}
	const normalized = normalizePromptForDisplay(prompt);
	if (normalized.length <= maxChars) {
		return normalized;
	}
	const truncated = normalized.slice(0, maxChars).trimEnd();
	return `${truncated}…`;
}
