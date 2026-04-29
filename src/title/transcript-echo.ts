const INLINE_TRANSCRIPT_ECHO = /\s+human\s+generated\s+(?:human|user|assistant|agent|system)\s*:/iu;
const LEADING_TRANSCRIPT_ECHO = /^(?:human\s+generated\s+)?(?:human|user|assistant|agent|system)\s*:/iu;
const ROLE_LABEL_LINE = /^(?:human|user|assistant|agent|system)\s*:/iu;
const HUMAN_GENERATED_LINE = /^human\s+generated$/iu;

export function trimGeneratedTranscriptEcho(raw: string): string | null {
	const compact = trimMultilineTranscriptEcho(raw).replace(/\s+/g, " ").trim();
	if (!compact || LEADING_TRANSCRIPT_ECHO.test(compact) || HUMAN_GENERATED_LINE.test(compact)) {
		return null;
	}

	const inlineMarkerIndex = compact.search(INLINE_TRANSCRIPT_ECHO);
	if (inlineMarkerIndex > 0) {
		return compact.slice(0, inlineMarkerIndex).trim() || null;
	}
	return compact;
}

function trimMultilineTranscriptEcho(raw: string): string {
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length <= 1) {
		return raw;
	}

	const echoIndex = lines.findIndex(
		(line, index) =>
			ROLE_LABEL_LINE.test(line) ||
			(HUMAN_GENERATED_LINE.test(line) && ROLE_LABEL_LINE.test(lines[index + 1] ?? "")),
	);
	if (echoIndex === 0) {
		return "";
	}
	if (echoIndex > 0) {
		return lines.slice(0, echoIndex).join(" ");
	}
	return raw;
}
