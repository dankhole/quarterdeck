// Provider-neutral response cleanup for lightweight text generation. Keep this
// outside individual transports so CLI and HTTP providers enforce the same
// output boundary without depending on one another.

const PREAMBLE_PATTERNS = [
	/^(?:here(?:'s| is)(?: a| the)?|the)\s+(?:title|branch\s*name|summary|commit\s*message|result)\s*(?:is|would be|could be)?[:\-—]\s*/i,
	/^(?:title|branch\s*name|summary|commit\s*message|result)\s*[:\-—]\s*/i,
	/^(?:sure|okay|of course|certainly|absolutely)[!,.]?\s*(?:here(?:'s| is))?[:\-—]?\s*/i,
];

const TRAILING_NOISE =
	/\s*(?:let me know.*|is that (?:ok|okay|good|helpful).*|would you like.*|do you want.*|shall i.*)\s*[?.!]*$/i;

/**
 * Strip preamble, trailing noise, and outer quotes from a generated response.
 * Returns null if the result looks like a question or refusal rather than the
 * requested content.
 */
export function sanitizeGenerationResponse(raw: string): string | null {
	let text = raw.trim();

	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}

	for (const pattern of PREAMBLE_PATTERNS) {
		text = text.replace(pattern, "");
	}

	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}

	text = text.replace(TRAILING_NOISE, "").trim();

	if (
		/^(?:i (?:can't|cannot|couldn't|don't|need|would need)|what |which |could you|can you|please (?:provide|clarify))/i.test(
			text,
		)
	) {
		return null;
	}

	return text || null;
}
