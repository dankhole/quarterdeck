import type { RuntimeTaskSessionSummary } from "../core";
import type { PreparedAgentLaunch } from "./agent-session-adapters";
import { canApplyClaudeRenderedTurnInterruption, type SessionTransitionEvent } from "./session-state-machine";
import type { TerminalScreenSnapshot } from "./terminal-state-mirror";

// Claude Code renders a user interruption (Esc) as a result row beneath the
// interrupted message or tool call, then returns to its composer. Claude's
// documented Stop hook does not run for user interrupts, so this rendered
// result is the only evidence that the foreground turn ended.
const INTERRUPTION_RESULT = "⎿ interrupted · what should claude do instead?";
const INTERRUPTION_RESULT_PREFIX = "⎿ interrupted";
const MAX_WRAPPED_RESULT_ROWS = 3;
// The composer's top border: a box top (`╭───╮`) or a bare horizontal rule.
const COMPOSER_TOP_BORDER = /^[╭┌]?─{8,}/u;
// The composer's first input row, optionally inside the box's side border.
const COMPOSER_INPUT_ROW = /^(?:│ ?)?[>❯](?: |$)/u;

function normalizeLine(line: string): string {
	return line.replace(/\s+/gu, " ").trim().toLowerCase();
}

function isComposerAt(lines: readonly string[], borderIndex: number): boolean {
	const border = lines[borderIndex]?.trim() ?? "";
	const input = lines[borderIndex + 1]?.trim() ?? "";
	return COMPOSER_TOP_BORDER.test(border) && COMPOSER_INPUT_ROW.test(input);
}

function findNewestComposerTopBorder(lines: readonly string[]): number {
	for (let index = lines.length - 2; index >= 0; index -= 1) {
		// Most rows cannot be the composer border; avoid regex work on every
		// row of every mirrored write while Claude is working.
		if (!lines[index]?.includes("─")) continue;
		if (isComposerAt(lines, index)) return index;
	}
	return -1;
}

function hasCompleteInterruptionEndingAt(lines: readonly string[], expectedEnd: number): boolean {
	const firstPossibleStart = Math.max(0, expectedEnd - MAX_WRAPPED_RESULT_ROWS + 1);
	for (let start = firstPossibleStart; start <= expectedEnd; start += 1) {
		if (!normalizeLine(lines[start] ?? "").startsWith(INTERRUPTION_RESULT_PREFIX)) continue;
		let candidate = "";
		for (let end = start; end <= expectedEnd; end += 1) {
			const fragment = normalizeLine(lines[end] ?? "");
			if (!fragment) break;
			candidate = `${candidate} ${fragment}`.trim();
			if (candidate === INTERRUPTION_RESULT) return end === expectedEnd;
			if (!INTERRUPTION_RESULT.startsWith(candidate)) break;
		}
	}
	return false;
}

/**
 * Recognizes Claude's rendered user-interruption result as the newest
 * transcript row immediately above its active composer in the visible
 * viewport. Only blank rows may separate them: a working spinner, newer
 * transcript, quoted text, or any other chrome keeps the text inert.
 */
export function isClaudeTurnInterruptedScreen(screen: TerminalScreenSnapshot): boolean {
	const composerIndex = findNewestComposerTopBorder(screen.lines);
	if (composerIndex < 0) return false;
	let resultEnd = composerIndex - 1;
	while (resultEnd >= 0 && !(screen.lines[resultEnd] ?? "").trim()) {
		resultEnd -= 1;
	}
	return resultEnd >= 0 && hasCompleteInterruptionEndingAt(screen.lines, resultEnd);
}

/** How long a bare Escape keeps rendered-screen inspection armed. Claude renders its result immediately. */
export const CLAUDE_RENDERED_INTERRUPTION_ESCAPE_WINDOW_MS = 5_000;

/**
 * This compatibility evidence may only remove Running or the current
 * foreground Claude permission wait from the current launch; it never asserts
 * work. It is armed only by a bare Escape sent to an eligible task, so stale
 * frames and transcript redraws on later turns stay inert, and ordinary
 * Running output is not held for screen inspection.
 */
export interface ClaudeTurnInterruptionDetector {
	/** Records a bare Escape written to the provider while the task could be interrupted. */
	observeBareEscape: (summary: RuntimeTaskSessionSummary, occurredAt: number) => void;
	/** True only while a recent Escape awaits Claude's rendered result. */
	shouldInspect: (summary: RuntimeTaskSessionSummary) => boolean;
	detect: (screen: TerminalScreenSnapshot, summary: RuntimeTaskSessionSummary) => SessionTransitionEvent | null;
	/** Disarms a pending Escape; called whenever provider evidence establishes Running. */
	reset: () => void;
}

export function createClaudeTurnInterruptionDetector(
	launchSessionInstanceId?: string,
	now: () => number = Date.now,
): ClaudeTurnInterruptionDetector {
	let escapeAt: number | null = null;
	const isEligible = (summary: RuntimeTaskSessionSummary) =>
		(launchSessionInstanceId === undefined || summary.sessionInstanceId === launchSessionInstanceId) &&
		canApplyClaudeRenderedTurnInterruption(summary);
	const isArmed = () => {
		if (escapeAt !== null && now() - escapeAt > CLAUDE_RENDERED_INTERRUPTION_ESCAPE_WINDOW_MS) {
			escapeAt = null;
		}
		return escapeAt !== null;
	};
	return {
		observeBareEscape(summary, occurredAt) {
			if (isEligible(summary)) escapeAt = occurredAt;
		},
		shouldInspect(summary) {
			return isArmed() && isEligible(summary);
		},
		detect(screen, summary) {
			if (!isArmed() || !isEligible(summary) || !isClaudeTurnInterruptedScreen(screen)) return null;
			// One Escape yields at most one transition; redraws of the same result stay inert.
			escapeAt = null;
			return { type: "agent.rendered-turn-interrupted", provider: "claude" };
		},
		reset() {
			escapeAt = null;
		},
	};
}

/** Launch-scoped output-transition hooks for one Claude PTY. */
export function createClaudeOutputTransitionHooks(
	launchSessionInstanceId: string | undefined,
): Required<
	Pick<
		PreparedAgentLaunch,
		| "detectOutputTransition"
		| "shouldInspectOutputForTransition"
		| "resetOutputTransitionDetection"
		| "observeBareEscapeInput"
	>
> {
	const detector = createClaudeTurnInterruptionDetector(launchSessionInstanceId);
	return {
		detectOutputTransition: detector.detect,
		shouldInspectOutputForTransition: detector.shouldInspect,
		resetOutputTransitionDetection: detector.reset,
		observeBareEscapeInput: detector.observeBareEscape,
	};
}
