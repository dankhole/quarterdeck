import { areFileSystemPathsEqual, isFileSystemPathWithin, type RuntimeAgentId } from "../core";
import { getTaskWorktreesHomePath } from "../state/project-state";
import type { TerminalScreenSnapshot } from "./terminal-state-mirror";

export const WORKSPACE_TRUST_CONFIRM_DELAY_MS = 100;

// Claude Code renders the trust dialog as a two-option select. Current
// releases list "No" first and focus it, and refuse keys that arrive shortly
// after the dialog opens; older releases list and focus "Yes" first. Only the
// rendered selection is trustworthy, so confirmation is keyed off the screen.
const CLAUDE_TRUST_CONFIRM_LABEL = "yes, i trust this folder";
const CLAUDE_TRUST_CANCEL_LABELS = ["no, exit", "no, continue without these permissions"] as const;
const CLAUDE_SELECT_POINTER = /^(?:\u276f|\u203a|>)\s*(?:\d+\.\s*)?/u;
const CLAUDE_SELECT_INDEX = /^\d+\.\s*/u;
/** Narrow terminals wrap an option label onto continuation rows. */
const MAX_TRUST_OPTION_CONTINUATION_ROWS = 2;

/** Claude refuses select input for 150 ms after the dialog opens; stay well clear. */
export const CLAUDE_WORKSPACE_TRUST_INPUT_GUARD_MS = 400;
/** Minimum spacing between keys so each one is rendered before the next decision. */
export const CLAUDE_WORKSPACE_TRUST_KEY_SETTLE_MS = 250;
/** Give up when Claude never re-renders after a key. */
export const CLAUDE_WORKSPACE_TRUST_KEY_RESPONSE_TIMEOUT_MS = 3_000;
/** "No" and "Yes" are adjacent; more presses mean the dialog is not what we expect. */
export const MAX_CLAUDE_WORKSPACE_TRUST_NAVIGATION_KEYS = 2;
export const CLAUDE_WORKSPACE_TRUST_NEXT_OPTION_KEY = "\u001b[B";

export type ClaudeWorkspaceTrustSelection = "confirm" | "cancel";

export interface ClaudeWorkspaceTrustScreen {
	visible: boolean;
	selection: ClaudeWorkspaceTrustSelection | null;
}

export interface ClaudeWorkspaceTrustDriverState {
	dialogVisibleSince: number | null;
	selection: ClaudeWorkspaceTrustSelection | null;
	lastKeyAt: number | null;
	awaitingFrameAfterKey: boolean;
	navigationKeyCount: number;
	/** Advanced before each output chunk reaches the mirror; keys are only sent for the newest rendered frame. */
	outputRevision: number;
	/** Direct keyboard input took over the visible dialog; cleared only once the dialog disappears. */
	manualInput: boolean;
}

export type ClaudeWorkspaceTrustAction =
	| { type: "idle" }
	| { type: "wait"; until: number }
	| { type: "confirm" }
	| { type: "select_confirm" }
	| { type: "give_up"; reason: "no_frame_after_key" | "confirm_option_unreachable" };

const TRUST_OPTION_LABELS: ReadonlyArray<{ kind: ClaudeWorkspaceTrustSelection; label: string }> = [
	{ kind: "confirm", label: CLAUDE_TRUST_CONFIRM_LABEL },
	...CLAUDE_TRUST_CANCEL_LABELS.map((label) => ({ kind: "cancel" as const, label })),
];

interface TrustOption {
	kind: ClaudeWorkspaceTrustSelection;
	selected: boolean;
	/** Last row of the option, including wrapped label continuations. */
	endRow: number;
}

function normalizeRow(line: string | undefined): string {
	return (line ?? "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function parseTrustOptionAt(lines: readonly string[], row: number): TrustOption | null {
	const first = normalizeRow(lines[row]);
	const pointer = CLAUDE_SELECT_POINTER.exec(first);
	const label = pointer ? first.slice(pointer[0].length) : first.replace(CLAUDE_SELECT_INDEX, "");
	if (!label) return null;
	for (const option of TRUST_OPTION_LABELS) {
		let candidate = label;
		let endRow = row;
		while (!candidate.startsWith(option.label)) {
			if (!option.label.startsWith(candidate) || endRow - row >= MAX_TRUST_OPTION_CONTINUATION_ROWS) break;
			endRow += 1;
			const continuation = normalizeRow(lines[endRow]);
			if (!continuation) break;
			candidate = `${candidate} ${continuation}`;
		}
		if (candidate.startsWith(option.label)) {
			return { kind: option.kind, selected: pointer !== null, endRow };
		}
	}
	return null;
}

/**
 * Reads Claude's workspace trust select from the rendered viewport. Both
 * options must be contiguous rows of one select (a wrapped label may continue
 * onto following rows); scattered or repeated option text is not a dialog.
 */
export function readClaudeWorkspaceTrustScreen(screen: TerminalScreenSnapshot): ClaudeWorkspaceTrustScreen {
	const dialogs: Array<[TrustOption, TrustOption]> = [];
	for (let row = 0; row < screen.lines.length; row += 1) {
		const first = parseTrustOptionAt(screen.lines, row);
		if (!first) continue;
		const second = parseTrustOptionAt(screen.lines, first.endRow + 1);
		if (second && second.kind !== first.kind) dialogs.push([first, second]);
	}
	const dialog = dialogs[0];
	if (!dialog) {
		return { visible: false, selection: null };
	}
	const [first, second] = dialog;
	// Ambiguous screens are visible (so no key is sent) but never selected.
	if (dialogs.length > 1 || first.selected === second.selected) {
		return { visible: true, selection: null };
	}
	return { visible: true, selection: first.selected ? first.kind : second.kind };
}

export function createClaudeWorkspaceTrustDriverState(): ClaudeWorkspaceTrustDriverState {
	return {
		dialogVisibleSince: null,
		selection: null,
		lastKeyAt: null,
		awaitingFrameAfterKey: false,
		navigationKeyCount: 0,
		outputRevision: 0,
		manualInput: false,
	};
}

export function observeClaudeWorkspaceTrustScreen(
	state: ClaudeWorkspaceTrustDriverState,
	screen: TerminalScreenSnapshot,
	now: number,
): void {
	const view = readClaudeWorkspaceTrustScreen(screen);
	state.awaitingFrameAfterKey = false;
	if (!view.visible) {
		state.dialogVisibleSince = null;
		state.selection = null;
		state.navigationKeyCount = 0;
		state.manualInput = false;
		return;
	}
	state.dialogVisibleSince ??= now;
	state.selection = view.selection;
}

/**
 * Enter is only ever chosen when the most recent frame rendered after our last
 * key shows "Yes, I trust this folder" selected. Escape is never sent because
 * it declines trust and exits Claude. A user typing into the dialog owns it
 * until it closes.
 */
export function decideClaudeWorkspaceTrustAction(
	state: ClaudeWorkspaceTrustDriverState,
	now: number,
): ClaudeWorkspaceTrustAction {
	if (state.manualInput) {
		return { type: "idle" };
	}
	if (state.awaitingFrameAfterKey && state.lastKeyAt !== null) {
		const timeoutAt = state.lastKeyAt + CLAUDE_WORKSPACE_TRUST_KEY_RESPONSE_TIMEOUT_MS;
		return now >= timeoutAt ? { type: "give_up", reason: "no_frame_after_key" } : { type: "wait", until: timeoutAt };
	}
	if (state.dialogVisibleSince === null) {
		return { type: "idle" };
	}
	const readyAt = Math.max(
		state.dialogVisibleSince + CLAUDE_WORKSPACE_TRUST_INPUT_GUARD_MS,
		state.lastKeyAt === null ? 0 : state.lastKeyAt + CLAUDE_WORKSPACE_TRUST_KEY_SETTLE_MS,
	);
	if (now < readyAt) {
		return { type: "wait", until: readyAt };
	}
	if (state.selection === "confirm") {
		return { type: "confirm" };
	}
	if (state.selection === "cancel") {
		return state.navigationKeyCount >= MAX_CLAUDE_WORKSPACE_TRUST_NAVIGATION_KEYS
			? { type: "give_up", reason: "confirm_option_unreachable" }
			: { type: "select_confirm" };
	}
	return { type: "idle" };
}

export function recordClaudeWorkspaceTrustKey(
	state: ClaudeWorkspaceTrustDriverState,
	action: "confirm" | "select_confirm",
	now: number,
): void {
	state.lastKeyAt = now;
	if (action === "select_confirm") {
		state.navigationKeyCount += 1;
		state.awaitingFrameAfterKey = true;
		return;
	}
	// A refused Enter remounts the dialog; treat any later frame as a new dialog.
	state.dialogVisibleSince = null;
	state.selection = null;
	state.navigationKeyCount = 0;
}

function isTaskWorktreePath(path: string): boolean {
	return isFileSystemPathWithin(getTaskWorktreesHomePath(), path);
}

export function shouldAutoConfirmClaudeWorkspaceTrust(
	agentId: RuntimeAgentId,
	cwd: string,
	workspacePath?: string,
): boolean {
	if (agentId !== "claude") {
		return false;
	}
	// Trust worktree paths under ~/.quarterdeck/worktrees/.
	if (isTaskWorktreePath(cwd)) {
		return true;
	}
	// Trust the main checkout when the runtime explicitly assigned it as the task's CWD.
	if (workspacePath && areFileSystemPathsEqual(cwd, workspacePath)) {
		return true;
	}
	return false;
}

export function stopWorkspaceTrustTimers(state: { workspaceTrustConfirmTimer: NodeJS.Timeout | null }): void {
	if (state.workspaceTrustConfirmTimer) {
		clearTimeout(state.workspaceTrustConfirmTimer);
		state.workspaceTrustConfirmTimer = null;
	}
}
