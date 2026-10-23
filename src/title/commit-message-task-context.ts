import type { CompletedAgentResponse } from "../core";

const ORIGINAL_PROMPT_LIMIT = 500;
const RESPONSE_LIMIT = 500;
const PREVIOUS_RESPONSE_LIMIT = 300;

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

export function buildCommitMessageTaskContext({
	prompt,
	completedResponses,
	finalMessage,
}: {
	prompt: string | null | undefined;
	completedResponses: CompletedAgentResponse[];
	finalMessage: string | null | undefined;
}): string | null {
	const parts: string[] = [];
	appendContextPart(parts, "Original prompt", prompt, ORIGINAL_PROMPT_LIMIT);

	if (completedResponses.length > 0) {
		const first = completedResponses[0];
		appendContextPart(parts, "First agent response", first?.text, RESPONSE_LIMIT);
		const normalizedFinalMessage = normalizeContextText(finalMessage);
		const finalMessageDuplicatesResponse =
			normalizedFinalMessage.length > 0 &&
			completedResponses.some((response) => normalizeContextText(response.text) === normalizedFinalMessage);

		const latest = completedResponses[completedResponses.length - 1];
		if (normalizedFinalMessage && !finalMessageDuplicatesResponse) {
			appendContextPart(parts, "Most recent agent response", finalMessage, RESPONSE_LIMIT);
			if (latest && latest !== first) {
				appendContextPart(parts, "Previous agent response", latest.text, PREVIOUS_RESPONSE_LIMIT);
			}
		} else {
			if (latest && latest !== first) {
				appendContextPart(parts, "Most recent agent response", latest.text, RESPONSE_LIMIT);
			}

			const previous = completedResponses.length > 2 ? completedResponses[completedResponses.length - 2] : null;
			if (previous && previous !== first && previous !== latest) {
				appendContextPart(parts, "Previous agent response", previous.text, PREVIOUS_RESPONSE_LIMIT);
			}
		}
	} else {
		appendContextPart(parts, "Most recent agent response", finalMessage, RESPONSE_LIMIT);
	}

	return parts.length > 0 ? parts.join("\n\n") : null;
}
