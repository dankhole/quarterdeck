import type { AgentOutputTransitionDetector } from "./agent-session-adapters";
import type { TerminalScreenSnapshot } from "./terminal-state-mirror";

const APPROVAL_FOOTER_PREFIX = "press enter to confirm or esc to";
const STATIC_APPROVAL_TITLES = [
	"would you like to run the following command?",
	"would you like to grant these permissions?",
	"would you like to make the following edits?",
] as const;
const MAX_WRAPPED_TITLE_ROWS = 3;

function normalizeLine(input: string): string {
	return input.replace(/\s+/g, " ").trim().toLowerCase();
}

function isApprovalTitle(candidate: string): boolean {
	return (
		STATIC_APPROVAL_TITLES.some((title) => candidate === title) ||
		/^do you want to approve network access to "[^"]+"\?$/.test(candidate) ||
		/^\S+ needs your approval\.$/.test(candidate)
	);
}

function findLastNonEmptyLine(lines: readonly string[]): number {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (normalizeLine(lines[index] ?? "")) {
			return index;
		}
	}
	return -1;
}

function findSelectedChoice(lines: readonly string[], footerIndex: number): number {
	for (let index = footerIndex - 1; index >= 0; index -= 1) {
		if (/^(?:›|>)\s*\d+\.\s+\S/.test((lines[index] ?? "").trimStart())) {
			return index;
		}
	}
	return -1;
}

/** Row index where the canonical approval title begins, or -1. */
function findApprovalTitleBeforeChoice(lines: readonly string[], selectedChoiceIndex: number): number {
	for (let start = 0; start < selectedChoiceIndex; start += 1) {
		let candidate = "";
		for (let end = start; end < selectedChoiceIndex && end < start + MAX_WRAPPED_TITLE_ROWS; end += 1) {
			const fragment = normalizeLine(lines[end] ?? "");
			if (!fragment) {
				break;
			}
			candidate = `${candidate} ${fragment}`.trim();
			if (isApprovalTitle(candidate)) {
				return start;
			}
		}
	}
	return -1;
}

function findFirstChoice(lines: readonly string[], titleIndex: number, selectedChoiceIndex: number): number {
	for (let index = titleIndex; index <= selectedChoiceIndex; index += 1) {
		if (/^(?:›|>)?\s*\d+\.\s+\S/.test((lines[index] ?? "").trimStart())) {
			return index;
		}
	}
	return selectedChoiceIndex;
}

/** A recognized approval overlay and the request it describes. */
export interface CodexApprovalScreen {
	/** Title and request rows above the choices; moving the selection does not change it. */
	signature: string;
	/** The overlay names another thread (a subagent's request) with a `Thread:` header. */
	threadLabeled: boolean;
}

/**
 * Recognizes Codex's actionable approval bottom pane from the rendered xterm
 * viewport. Requiring the anchored footer, selected choice, and canonical
 * title prevents ordinary transcript/source output from becoming lifecycle
 * truth while still accepting narrow, clipped footer text.
 */
export function readCodexApprovalScreen(screen: TerminalScreenSnapshot): CodexApprovalScreen | null {
	const footerIndex = findLastNonEmptyLine(screen.lines);
	if (footerIndex < Math.max(0, screen.rows - 2)) {
		return null;
	}
	const footer = normalizeLine(screen.lines[footerIndex] ?? "");
	if (!footer.startsWith(APPROVAL_FOOTER_PREFIX)) {
		return null;
	}
	const selectedChoiceIndex = findSelectedChoice(screen.lines, footerIndex);
	if (selectedChoiceIndex < 0) return null;
	const titleIndex = findApprovalTitleBeforeChoice(screen.lines, selectedChoiceIndex);
	if (titleIndex < 0) return null;
	const requestRows = screen.lines
		.slice(titleIndex, findFirstChoice(screen.lines, titleIndex, selectedChoiceIndex))
		.map(normalizeLine)
		.filter(Boolean);
	return {
		signature: requestRows.join("\n"),
		threadLabeled: requestRows.some((row) => /^thread: \S/.test(row)),
	};
}

export function isCodexApprovalScreen(screen: TerminalScreenSnapshot): boolean {
	return readCodexApprovalScreen(screen) !== null;
}

export interface CodexApprovalPromptDetector {
	detect: AgentOutputTransitionDetector;
	reset: () => void;
}

/**
 * TEMPORARY COMPATIBILITY SHIM — this infers semantic lifecycle state from
 * terminal presentation and is intentionally not a preferred state source.
 *
 * Supported Codex releases can render nested Code Mode approvals without a
 * `PermissionRequest` hook, and that hook precedes reviewer routing rather
 * than proving a person must answer. Native hooks still own resumed work.
 * Delete this detector only when the minimum supported Codex version exposes
 * a structured human-wait signal for every displayed approval, including
 * inherited reviewer configuration; do not broaden it to other output.
 */
export function createCodexApprovalPromptDetector(): CodexApprovalPromptDetector {
	let detectedSignature: string | null = null;

	return {
		detect(screen) {
			const approval = readCodexApprovalScreen(screen);
			if (!approval) {
				// A submitted response can leave the task response-pending while
				// Codex clears the old overlay and later opens another one. Re-arm
				// on that visible falling edge so redraws of one prompt cannot
				// manufacture duplicate interactions.
				detectedSignature = null;
				return null;
			}
			// Codex can replace one queued approval with the next without an empty
			// frame (for example a subagent's labelled request followed by a
			// foreground one). A different request re-arms detection.
			if (detectedSignature === approval.signature) {
				return null;
			}
			detectedSignature = approval.signature;
			return { type: "agent.permission-prompt", threadLabeled: approval.threadLabeled };
		},
		reset() {
			detectedSignature = null;
		},
	};
}
