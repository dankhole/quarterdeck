const TOAST_TRUNCATE_THRESHOLD = 150;

/**
 * Prepare an error message for toast display.
 * Truncates to the first non-empty line if the message is multi-line or too
 * long (safety net for e.g. multi-page pre-commit hook output).
 */
export function sanitizeErrorForToast(message: string): string {
	if (message.length <= TOAST_TRUNCATE_THRESHOLD && !message.includes("\n")) {
		return message;
	}
	const firstLine = message
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!firstLine) return message;
	if (firstLine.length <= TOAST_TRUNCATE_THRESHOLD) return firstLine;
	return `${firstLine.slice(0, TOAST_TRUNCATE_THRESHOLD - 1)}\u2026`;
}
