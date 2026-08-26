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

function hasApprovalTitleBeforeChoice(lines: readonly string[], selectedChoiceIndex: number): boolean {
	for (let start = 0; start < selectedChoiceIndex; start += 1) {
		let candidate = "";
		for (let end = start; end < selectedChoiceIndex && end < start + MAX_WRAPPED_TITLE_ROWS; end += 1) {
			const fragment = normalizeLine(lines[end] ?? "");
			if (!fragment) {
				break;
			}
			candidate = `${candidate} ${fragment}`.trim();
			if (isApprovalTitle(candidate)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Recognizes Codex's actionable approval bottom pane from the rendered xterm
 * viewport. Requiring the anchored footer, selected choice, and canonical
 * title prevents ordinary transcript/source output from becoming lifecycle
 * truth while still accepting narrow, clipped footer text.
 */
export function isCodexApprovalScreen(screen: TerminalScreenSnapshot): boolean {
	const footerIndex = findLastNonEmptyLine(screen.lines);
	if (footerIndex < Math.max(0, screen.rows - 2)) {
		return false;
	}
	const footer = normalizeLine(screen.lines[footerIndex] ?? "");
	if (!footer.startsWith(APPROVAL_FOOTER_PREFIX)) {
		return false;
	}
	const selectedChoiceIndex = findSelectedChoice(screen.lines, footerIndex);
	return selectedChoiceIndex >= 0 && hasApprovalTitleBeforeChoice(screen.lines, selectedChoiceIndex);
}

export interface CodexApprovalPromptDetector {
	detect: AgentOutputTransitionDetector;
	reset: () => void;
}

/**
 * TEMPORARY COMPATIBILITY SHIM — this infers semantic lifecycle state from
 * terminal presentation and is intentionally not a preferred state source.
 *
 * It exists only because supported Codex releases can render approvals from
 * nested Code Mode executions without emitting the corresponding structured
 * `PermissionRequest` hook. Native hooks remain authoritative. Delete this
 * detector once Quarterdeck's minimum supported Codex version emits that hook
 * for every displayed approval; do not broaden it to other terminal output.
 */
export function createCodexApprovalPromptDetector(): CodexApprovalPromptDetector {
	let detected = false;

	return {
		detect(screen) {
			const approvalVisible = isCodexApprovalScreen(screen);
			if (!approvalVisible) {
				// A submitted response can leave the task response-pending while
				// Codex clears the old overlay and later opens another one. Re-arm
				// only on that visible falling edge so redraws of one prompt cannot
				// manufacture duplicate interactions.
				detected = false;
				return null;
			}
			if (detected) {
				return null;
			}
			detected = true;
			return { type: "agent.permission-prompt" };
		},
		reset() {
			detected = false;
		},
	};
}
