const MAX_SUMMARY_LENGTH = 360;
const MAX_SUMMARY_LINES = 3;
const FALLBACK_SUMMARY = "Git could not complete this action. View the details for more information.";

// Git writes progress and successful ref updates to stderr too.
const PROGRESS_LINE =
	/^(?:remote:(?!\s*(?:fatal|error):)|From\s|To\s|[ *+!-]+\s*\[|(?:Receiving|Resolving|Counting|Compressing|Enumerating|Updating)\s|Total\s|Already up to date\.?$)/i;
const COMMAND_FAILURE_HEADER = /^Command failed:/i;

function summaryBlock(lines: string[], start: number): string {
	const selected: string[] = [];
	for (const line of lines.slice(start)) {
		if (!line || PROGRESS_LINE.test(line) || selected.length === MAX_SUMMARY_LINES) break;
		selected.push(line);
	}
	const text = selected.join("\n");
	return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : text;
}

function failureLineIndex(lines: string[]): number {
	const fatal = lines.findIndex((line) => /^(?:remote:\s*)?fatal:/i.test(line));
	return fatal >= 0 ? fatal : lines.findIndex((line) => /^(?:remote:\s*)?error:/i.test(line));
}

function linesOf(text: string): string[] {
	return text.split(/\r\n|[\r\n]/).map((line) => line.trim());
}

export function getGitActionErrorPresentation(
	message: string,
	output: string | null,
): {
	summary: string;
	details: string;
} {
	const messageText = message.trim();
	const outputText = output?.trim() ?? "";
	// Legacy results often put all stderr in message and stdout + stderr in output.
	const details = outputText.includes(messageText)
		? outputText
		: messageText.includes(outputText)
			? messageText
			: [messageText, outputText].filter(Boolean).join("\n\n");
	const messageLines = linesOf(messageText);
	const messageFailure = failureLineIndex(messageLines);
	if (messageFailure >= 0) {
		return { summary: summaryBlock(messageLines, messageFailure), details };
	}
	// Explicit runtime errors (including timeouts) take precedence over partial output.
	if (
		messageLines.length === 1 &&
		messageText &&
		!PROGRESS_LINE.test(messageText) &&
		!COMMAND_FAILURE_HEADER.test(messageText)
	) {
		return { summary: summaryBlock(messageLines, 0), details };
	}
	const outputLines = linesOf(outputText);
	const outputFailure = failureLineIndex(outputLines);
	if (outputFailure >= 0) {
		return { summary: summaryBlock(outputLines, outputFailure), details };
	}
	const messageStart = messageLines.findIndex((line) => line && !COMMAND_FAILURE_HEADER.test(line));
	return {
		summary:
			messageStart >= 0 && !messageLines.some((line) => PROGRESS_LINE.test(line))
				? summaryBlock(messageLines, messageStart)
				: FALLBACK_SUMMARY,
		details,
	};
}
