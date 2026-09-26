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
const MAX_TRUST_OPTION_ROW_DISTANCE = 3;

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
}

export type ClaudeWorkspaceTrustAction =
	| { type: "idle" }
	| { type: "wait"; until: number }
	| { type: "confirm" }
	| { type: "select_confirm" }
	| { type: "give_up"; reason: "no_frame_after_key" | "confirm_option_unreachable" };

interface TrustOptionRow {
	kind: ClaudeWorkspaceTrustSelection;
	selected: boolean;
}

function parseTrustOptionRow(line: string): TrustOptionRow | null {
	const normalized = line.replace(/\s+/gu, " ").trim().toLowerCase();
	const pointer = CLAUDE_SELECT_POINTER.exec(normalized);
	const label = pointer ? normalized.slice(pointer[0].length) : normalized.replace(CLAUDE_SELECT_INDEX, "");
	if (label.startsWith(CLAUDE_TRUST_CONFIRM_LABEL)) {
		return { kind: "confirm", selected: pointer !== null };
	}
	if (CLAUDE_TRUST_CANCEL_LABELS.some((cancelLabel) => label.startsWith(cancelLabel))) {
		return { kind: "cancel", selected: pointer !== null };
	}
	return null;
}

/** Reads Claude's workspace trust select from the rendered viewport. */
export function readClaudeWorkspaceTrustScreen(screen: TerminalScreenSnapshot): ClaudeWorkspaceTrustScreen {
	let confirmRow: { row: number; option: TrustOptionRow } | null = null;
	let cancelRow: { row: number; option: TrustOptionRow } | null = null;
	for (let row = 0; row < screen.lines.length; row += 1) {
		const option = parseTrustOptionRow(screen.lines[row] ?? "");
		if (option?.kind === "confirm") confirmRow = { row, option };
		if (option?.kind === "cancel") cancelRow = { row, option };
	}
	if (!confirmRow || !cancelRow || Math.abs(confirmRow.row - cancelRow.row) > MAX_TRUST_OPTION_ROW_DISTANCE) {
		return { visible: false, selection: null };
	}
	const selection = confirmRow.option.selected ? "confirm" : cancelRow.option.selected ? "cancel" : null;
	return { visible: true, selection };
}

export function createClaudeWorkspaceTrustDriverState(): ClaudeWorkspaceTrustDriverState {
	return {
		dialogVisibleSince: null,
		selection: null,
		lastKeyAt: null,
		awaitingFrameAfterKey: false,
		navigationKeyCount: 0,
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
		return;
	}
	state.dialogVisibleSince ??= now;
	state.selection = view.selection;
}

/**
 * Enter is only ever chosen when the most recent frame rendered after our last
 * key shows "Yes, I trust this folder" selected. Escape is never sent because
 * it declines trust and exits Claude.
 */
export function decideClaudeWorkspaceTrustAction(
	state: ClaudeWorkspaceTrustDriverState,
	now: number,
): ClaudeWorkspaceTrustAction {
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
