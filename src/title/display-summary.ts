/** Hard display limit for card summaries. Longer summaries are truncated with an ellipsis. */
export const DISPLAY_SUMMARY_MAX_LENGTH = 90;

/**
 * Character budget given to the LLM in the system prompt. Set lower than
 * DISPLAY_SUMMARY_MAX_LENGTH so model overshoot still usually lands within the
 * display limit without needing a hard truncation.
 */
export const DISPLAY_SUMMARY_LLM_BUDGET = 75;

const SUMMARY_PREFIX_PATTERNS = [
	/^(?:summary|final answer|result)\s*[:\-—]\s*/i,
	/^(?:i(?:'ve| have)?\s+)/i,
	/^(?:done|completed)\s*[:\-—]\s*/i,
];

export function compactDisplaySummaryText(raw: string, maxLength = DISPLAY_SUMMARY_MAX_LENGTH): string | null {
	let text = raw.replace(/\s+/g, " ").trim();
	if (!text) {
		return null;
	}

	for (const pattern of SUMMARY_PREFIX_PATTERNS) {
		text = text.replace(pattern, "").trim();
	}

	if (!text) {
		return null;
	}
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength).trimEnd()}\u2026`;
}
