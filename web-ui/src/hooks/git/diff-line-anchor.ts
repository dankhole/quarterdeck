import { diffLines } from "diff";

/**
 * Relocates a 1-based source line through a line diff. Deleted anchors use the
 * nearest surviving source line, preferring the following line on a tie.
 * With fallback "none", only an unchanged anchored line can be relocated.
 * Empty text has no lines; invalid anchors or no surviving lines return null.
 */
export function relocateDiffLine(
	previousText: string,
	nextText: string,
	lineNumber: number,
	fallback: "nearest" | "none" = "nearest",
): number | null {
	if (!Number.isInteger(lineNumber) || lineNumber < 1) {
		return null;
	}

	if (previousText === nextText) {
		const lineCount = previousText === "" ? 0 : previousText.split("\n").length - Number(previousText.endsWith("\n"));
		return lineNumber <= lineCount ? lineNumber : null;
	}

	// Match the unified diff parser's CRLF and final-newline semantics without
	// treating repeated or blank lines as globally unique identifiers.
	const changes = diffLines(previousText, nextText, {
		ignoreWhitespace: false,
		stripTrailingCr: true,
		ignoreNewlineAtEof: true,
	});
	let previousLine = 1;
	let nextLine = 1;
	let nearestLine: number | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;

	for (const change of changes) {
		if (change.added) {
			nextLine += change.count;
		} else if (change.removed) {
			previousLine += change.count;
		} else {
			const candidate = Math.max(previousLine, Math.min(lineNumber, previousLine + change.count - 1));
			const distance = Math.abs(candidate - lineNumber);
			// Runs are in source order, so replacing equal distances selects the
			// following survivor rather than the preceding one.
			if (distance <= nearestDistance) {
				nearestDistance = distance;
				nearestLine = nextLine + candidate - previousLine;
			}
			previousLine += change.count;
			nextLine += change.count;
		}
	}

	return lineNumber < previousLine && (fallback === "nearest" || nearestDistance === 0) ? nearestLine : null;
}
