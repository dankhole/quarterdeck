import type { ConversationSummaryEntry } from "../core";

export const TITLE_ORIGINAL_PROMPT_LIMIT = 320;
export const TITLE_FIRST_ACTIVITY_LIMIT = 300;
export const TITLE_LATEST_ACTIVITY_LIMIT = 300;
export const TITLE_PREVIOUS_ACTIVITY_LIMIT = 180;
export const SUMMARY_ORIGINAL_PROMPT_LIMIT = 500;
export const SUMMARY_FIRST_ACTIVITY_LIMIT = 500;
export const SUMMARY_LATEST_ACTIVITY_LIMIT = 500;
export const SUMMARY_PREVIOUS_ACTIVITY_LIMIT = 300;

function limitGenerationContext(text: string, maxLength: number): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (trimmed.length <= maxLength) {
		return trimmed;
	}
	return `${trimmed.slice(0, maxLength).trimEnd()}\u2026`;
}

function appendContextPart(parts: string[], label: string, text: string | null | undefined, maxLength: number): void {
	const limited = text ? limitGenerationContext(text, maxLength) : "";
	if (limited) {
		parts.push(`${label}:\n${limited}`);
	}
}

function normalizeContextText(text: string | null | undefined): string {
	return text?.replace(/\s+/g, " ").trim() ?? "";
}

export function buildTaskGenerationContext({
	prompt,
	summaries,
	finalMessage,
	limits,
}: {
	prompt: string | null | undefined;
	summaries: ConversationSummaryEntry[];
	finalMessage: string | null | undefined;
	limits: {
		originalPrompt: number;
		firstActivity: number;
		latestActivity: number;
		previousActivity: number;
	};
}): string | null {
	const parts: string[] = [];
	appendContextPart(parts, "Original prompt", prompt, limits.originalPrompt);

	if (summaries.length > 0) {
		const first = summaries[0];
		appendContextPart(parts, "First agent summary", first?.text, limits.firstActivity);
		const normalizedFinalMessage = normalizeContextText(finalMessage);
		const finalMessageDuplicatesSummary =
			normalizedFinalMessage.length > 0 &&
			summaries.some((summary) => normalizeContextText(summary.text) === normalizedFinalMessage);

		const latest = summaries[summaries.length - 1];
		if (normalizedFinalMessage && !finalMessageDuplicatesSummary) {
			appendContextPart(parts, "Most recent agent summary", finalMessage, limits.latestActivity);
			if (latest && latest !== first) {
				appendContextPart(parts, "Previous agent summary", latest.text, limits.previousActivity);
			}
		} else {
			if (latest && latest !== first) {
				appendContextPart(parts, "Most recent agent summary", latest.text, limits.latestActivity);
			}

			const previous = summaries.length > 2 ? summaries[summaries.length - 2] : null;
			if (previous && previous !== first && previous !== latest) {
				appendContextPart(parts, "Previous agent summary", previous.text, limits.previousActivity);
			}
		}
	} else {
		appendContextPart(parts, "Most recent agent summary", finalMessage, limits.latestActivity);
	}

	return parts.length > 0 ? parts.join("\n\n") : null;
}
