/**
 * Accumulates raw terminal output into clean text suitable for HTML rendering.
 *
 * Handles:
 * - Stripping ANSI escape sequences (colors, cursor moves, etc.)
 * - Filtering cursor-save/restore blocks (status bar updates)
 * - Collapsing carriage-return line overwrites
 * - Converting raw chunks into accumulated lines
 */

// Use string-based RegExp construction to avoid Biome's noControlCharactersInRegex lint rule.
// These patterns match ANSI terminal escape sequences which inherently contain control characters.
const ESC = "\\u001b";
const BEL = "\\u0007";

// Matches cursor save: ESC 7 or CSI s
const CURSOR_SAVE_RE = new RegExp(`${ESC}7|${ESC}\\[s`);
// Matches cursor restore: ESC 8 or CSI u
const CURSOR_RESTORE_RE = new RegExp(`${ESC}8|${ESC}\\[u`);

// CSI sequences: ESC [ ... <final byte>
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
// OSC sequences: ESC ] ... (BEL or ST)
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
// Single-character escape sequences: ESC <char>
const SINGLE_ESC_RE = new RegExp(`${ESC}[@-Z\\\\^_7-8]`, "g");
// Remaining standalone ESC that didn't match above
const STRAY_ESC_RE = new RegExp(ESC, "g");

function stripAnsi(text: string): string {
	return text.replace(OSC_RE, "").replace(CSI_RE, "").replace(SINGLE_ESC_RE, "").replace(STRAY_ESC_RE, "");
}

/**
 * Remove content between cursor-save and cursor-restore sequences.
 * This filters out status bar redraws that use save/restore cursor positioning.
 */
function filterCursorSaveRestoreBlocks(text: string): string {
	let result = text;
	let iterations = 0;
	const maxIterations = 50;

	while (iterations < maxIterations) {
		const saveMatch = CURSOR_SAVE_RE.exec(result);
		if (!saveMatch) {
			break;
		}
		const saveEnd = saveMatch.index + saveMatch[0].length;
		const restOfText = result.slice(saveEnd);
		const restoreMatch = CURSOR_RESTORE_RE.exec(restOfText);
		if (!restoreMatch) {
			// Save without restore — strip from save to end of chunk
			// (restore likely in next chunk; keep text before save)
			result = result.slice(0, saveMatch.index);
			break;
		}
		const restoreEnd = saveEnd + restoreMatch.index + restoreMatch[0].length;
		result = result.slice(0, saveMatch.index) + result.slice(restoreEnd);
		iterations += 1;
	}
	return result;
}

/**
 * Handle carriage returns: a `\r` not followed by `\n` means the line
 * is being overwritten (e.g. progress spinners, status updates).
 * Keep only the last overwrite of each line.
 */
function collapseCarriageReturns(text: string): string {
	return text.replace(/[^\n]*\r(?!\n)/g, "");
}

export interface ChatOutputAccumulator {
	/** Feed a new raw terminal text chunk. Returns the new lines added. */
	push(chunk: string): string[];
	/** Get the full accumulated text as an array of lines. */
	getLines(): string[];
	/** Reset the accumulator. */
	clear(): void;
}

const MAX_LINES = 10_000;

export function createChatOutputAccumulator(): ChatOutputAccumulator {
	let lines: string[] = [];
	let pendingPartial = "";

	function push(rawChunk: string): string[] {
		// 1. Filter status-bar save/restore blocks
		const filtered = filterCursorSaveRestoreBlocks(rawChunk);

		// 2. Strip remaining ANSI sequences
		const clean = stripAnsi(filtered);

		// 3. Collapse carriage-return overwrites
		const collapsed = collapseCarriageReturns(clean);

		// 4. Normalize line endings
		const normalized = collapsed.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// 5. Split into lines, handling partial (unterminated) last line
		const combined = pendingPartial + normalized;
		const parts = combined.split("\n");

		// Last element is either "" (ended with \n) or a partial line
		pendingPartial = parts.pop() ?? "";

		// Complete lines to add
		const newLines = parts;
		if (newLines.length > 0) {
			lines = lines.concat(newLines);
			if (lines.length > MAX_LINES) {
				lines = lines.slice(lines.length - MAX_LINES);
			}
		}
		return newLines;
	}

	function getLines(): string[] {
		// Include the pending partial as the last line if non-empty
		if (pendingPartial.length > 0) {
			return [...lines, pendingPartial];
		}
		return [...lines];
	}

	function clear(): void {
		lines = [];
		pendingPartial = "";
	}

	return { push, getLines, clear };
}
