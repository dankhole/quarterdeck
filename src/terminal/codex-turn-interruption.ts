import type { RuntimeTaskSessionSummary } from "../core";
import { canApplyCodexRenderedTurnInterruption, type SessionTransitionEvent } from "./session-state-machine";
import type { TerminalScreenSnapshot } from "./terminal-state-mirror";

const INTERRUPTION_MESSAGE =
	"■ conversation interrupted - tell the model what to do differently. something went wrong? hit `/feedback` to report the issue.";
const INPUT_PROMPT = "› ask codex to do anything";
const MAX_WRAPPED_INTERRUPTION_ROWS = 5;

function normalizeLine(line: string): string {
	return line.replace(/\s+/g, " ").trim().toLowerCase();
}

function hasCompleteInterruptionEndingAt(lines: readonly string[], expectedEnd: number): boolean {
	const firstPossibleStart = Math.max(0, expectedEnd - MAX_WRAPPED_INTERRUPTION_ROWS + 1);
	for (let start = firstPossibleStart; start <= expectedEnd; start += 1) {
		const first = normalizeLine(lines[start] ?? "");
		if (!first.startsWith("■ conversation interrupted -")) continue;
		let candidate = "";
		for (let end = start; end <= expectedEnd; end += 1) {
			const fragment = normalizeLine(lines[end] ?? "");
			if (!fragment) break;
			candidate = `${candidate} ${fragment}`.trim();
			if (candidate === INTERRUPTION_MESSAGE) return end === expectedEnd;
			if (!INTERRUPTION_MESSAGE.startsWith(candidate)) break;
		}
	}
	return false;
}

/**
 * Recognizes Codex's rendered interrupted-turn result after it has returned to
 * its input prompt without emitting a native Stop hook. Both the complete
 * provider-owned failure text and the later canonical input prompt are
 * required in the visible viewport so transcript/source text cannot become a
 * general lifecycle signal.
 */
export function isCodexTurnInterruptedScreen(screen: TerminalScreenSnapshot): boolean {
	let inputPromptIndex = -1;
	for (let index = screen.lines.length - 1; index >= 0; index -= 1) {
		const line = screen.lines[index] ?? "";
		// Most output rows cannot be the composer; avoid normalizing those rows
		// on every mirrored write in attached high-output sessions.
		if (line.includes("›") && normalizeLine(line) === INPUT_PROMPT) {
			inputPromptIndex = index;
			break;
		}
	}
	if (inputPromptIndex < 0) return false;

	// The interruption must be the current terminal result immediately above
	// the active composer. Codex 0.157 can insert one Tip: chrome row here; skip
	// only that adjacent row, never arbitrary transcript, status, or tip blocks.
	// Historical interruption text above a newer result remains inert.
	let interruptionEnd = inputPromptIndex - 1;
	let skippedComposerTip = false;
	while (interruptionEnd >= 0) {
		const line = normalizeLine(screen.lines[interruptionEnd] ?? "");
		if (!line) {
			interruptionEnd -= 1;
			continue;
		}
		if (!skippedComposerTip && /^tip: \S/.test(line)) {
			skippedComposerTip = true;
			interruptionEnd -= 1;
			continue;
		}
		break;
	}
	return interruptionEnd >= 0 && hasCompleteInterruptionEndingAt(screen.lines, interruptionEnd);
}

/** This compatibility evidence may only remove Running or a current Codex permission wait; it never asserts work. */
export interface CodexTurnInterruptionDetector {
	detect: (screen: TerminalScreenSnapshot, summary: RuntimeTaskSessionSummary) => SessionTransitionEvent | null;
}

export function createCodexTurnInterruptionDetector(): CodexTurnInterruptionDetector {
	let detected = false;
	return {
		detect(screen, summary) {
			const interruptionVisible = isCodexTurnInterruptedScreen(screen);
			if (!interruptionVisible) {
				detected = false;
				return null;
			}
			if (detected) return null;
			detected = true;
			return canApplyCodexRenderedTurnInterruption(summary) ? { type: "agent.rendered-turn-interrupted" } : null;
		},
	};
}
