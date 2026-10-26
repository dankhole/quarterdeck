// Input routing pipeline for PTY sessions.
// Extracted from session-manager.ts — processes user keyboard input through
// an ordered pipeline: terminal protocol response detection → interrupt
// detection → PTY write → provider-ordering fence.

import { deriveTaskIndicatorState, type RuntimeTaskSessionSummary } from "../core";
import { recordClaudeInterruptKey, recordHookUserSubmission } from "./hook-event-order";
import { detectInterruptSignal, type InterruptSignal, scheduleInterruptRecovery } from "./session-interrupt-recovery";
import type { ProcessEntry } from "./session-manager-types";
import type { SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";
import { cancelWorkspaceTrustForUserInput } from "./session-workspace-trust";
import { resolveAlternateInteractionResponseTarget, resolveInteractionResponseTarget } from "./subagent-interactions";
import type { TerminalSessionInputOptions } from "./terminal-session-service";

const ESC = 0x1b;
const CSI_BRACKET = 0x5b; // [
const OSC_BRACKET = 0x5d; // ]
const DCS_INTRODUCER = 0x50; // P
const BEL = 0x07;
const ST_FINAL = 0x5c; // \ in ESC \
const CARRIAGE_RETURN = 0x0d;
const LOWERCASE_Y = 0x79;
const UPPERCASE_Y = 0x59;
const FIRST_NUMBERED_CHOICE = 0x31; // 1
const LAST_NUMBERED_CHOICE = 0x39; // 9

/**
 * Detects whether a writeInput buffer is entirely a terminal protocol response
 * (not user input). xterm.js sends these automatically through onData — e.g.
 * focus-in/out events when focus reporting is enabled, or DSR cursor position
 * reports. These should not be treated as user interaction.
 *
 * Known sequences:
 *   \x1b[I    — focus-in  (DECSET 1004)
 *   \x1b[O    — focus-out (DECSET 1004)
 *   \x1b[r;cR — DSR cursor position report
 *   \x1b[?…c / \x1b[>…c — primary/secondary device attributes replies
 *   \x1b[?…u / \x1b[?…$y — kitty keyboard flags and DECRPM mode replies
 *   \x1b]…BEL / \x1b]…ST — OSC replies (for example color queries)
 *   \x1bP…ST — DCS replies (for example XTVERSION)
 */
export function isTerminalProtocolResponse(data: Buffer): boolean {
	if (data.length >= 3 && data[0] === ESC && (data[1] === OSC_BRACKET || data[1] === DCS_INTRODUCER)) {
		return data[data.length - 1] === BEL || (data[data.length - 2] === ESC && data[data.length - 1] === ST_FINAL);
	}
	if (data.length < 3 || data[0] !== ESC || data[1] !== CSI_BRACKET) {
		return false;
	}
	const finalByte = data[data.length - 1] as number;
	// Focus-in (\x1b[I) and focus-out (\x1b[O) — exactly 3 bytes.
	if (data.length === 3 && (finalByte === 0x49 /* I */ || finalByte === 0x4f) /* O */) {
		return true;
	}
	// DSR cursor position report: \x1b[<digits>;<digits>R
	if (finalByte === 0x52 /* R */) {
		return hasOnlyCsiParameterDigits(data, 2, data.length - 1);
	}
	// Private-mode replies: device attributes (\x1b[?…c, \x1b[>…c), kitty
	// keyboard flags (\x1b[?…u), and DECRPM mode reports (\x1b[?…$y).
	if (data[2] === 0x3f /* ? */ || data[2] === 0x3e /* > */) {
		if (finalByte === 0x63 /* c */ || finalByte === 0x75 /* u */) {
			return hasOnlyCsiParameterDigits(data, 3, data.length - 1);
		}
		if (finalByte === 0x79 /* y */ && data[data.length - 2] === 0x24 /* $ */) {
			return hasOnlyCsiParameterDigits(data, 3, data.length - 2);
		}
	}
	return false;
}

function hasOnlyCsiParameterDigits(data: Buffer, start: number, end: number): boolean {
	for (let i = start; i < end; i++) {
		const byte = data[i] as number;
		if (byte !== 0x3b /* ; */ && (byte < 0x30 || byte > 0x39) /* 0-9 */) {
			return false;
		}
	}
	return true;
}

const MOUSE_MOTION_FLAG = 32;
const MOUSE_WHEEL_FLAG = 64;

function isPassiveMouseButtonCode(code: number): boolean {
	// Wheel (64-67) and motion reports carry modifier bits (4, 8, 16) on top;
	// presses and releases of buttons 0-2 are deliberate clicks.
	return code >= 32 && code <= 95 && ((code & MOUSE_WHEEL_FLAG) !== 0 || (code & MOUSE_MOTION_FLAG) !== 0);
}

/**
 * Detects a buffer made only of passive xterm mouse reports: wheel scrolling
 * or pointer motion, in SGR (`\x1b[<b;x;yM`) or X10 (`\x1b[M` plus three
 * bytes) encoding. Fullscreen providers enable mouse tracking, so scrolling
 * arrives as terminal input; clicks remain direct user input.
 */
export function isTerminalPassiveMouseReport(data: Buffer): boolean {
	let offset = 0;
	while (offset < data.length) {
		if (data[offset] !== ESC || data[offset + 1] !== CSI_BRACKET) return false;
		if (data[offset + 2] === 0x4d /* M */) {
			if (offset + 6 > data.length) return false;
			if (
				!isPassiveMouseButtonCode((data[offset + 3] as number) - 32) ||
				(data[offset + 4] as number) < 33 ||
				(data[offset + 5] as number) < 33
			)
				return false;
			offset += 6;
			continue;
		}
		if (data[offset + 2] !== 0x3c /* < */) return false;
		let index = offset + 3;
		let separators = 0;
		let parameterDigits = 0;
		let parameterValue = 0;
		let buttonCode = 0;
		while (index < data.length && data[index] !== 0x4d /* M */) {
			const byte = data[index] as number;
			if (byte === 0x3b /* ; */) {
				if (parameterDigits === 0 || separators === 2) return false;
				separators += 1;
				parameterDigits = 0;
				parameterValue = 0;
			} else {
				if (byte < 0x30 || byte > 0x39) return false;
				parameterDigits += 1;
				parameterValue = parameterValue * 10 + (byte - 0x30);
				if (parameterValue > Number.MAX_SAFE_INTEGER) return false;
				if (separators === 0) {
					buttonCode = parameterValue;
					if (buttonCode > 95) return false;
				}
			}
			index += 1;
		}
		if (index >= data.length || separators !== 2 || parameterDigits === 0 || !isPassiveMouseButtonCode(buttonCode)) {
			return false;
		}
		offset = index + 1;
	}
	return data.length > 0;
}

/** A normal Enter submission. Shift+Enter/newline remains ordinary editing. */
export function isExplicitUserSubmission(data: Buffer): boolean {
	return data.length === 1 && data[0] === CARRIAGE_RETURN;
}

/**
 * Codex approval panes expose `y` and numbered rows as immediate actions: the
 * TUI acts on those bytes without waiting for Enter. Recognize them only for
 * the exact foreground permission interaction already owned by the current
 * Codex session, or for a waiting Codex subagent approval that owns the dialog.
 * Claude's numbered permission rows count only while a waiting subagent
 * permission owns the dialog. Arbitrary terminal bytes, question text, and
 * other providers remain ordinary input and cannot manufacture a semantic
 * response boundary.
 */
export function isImmediateInteractionSubmission(summary: RuntimeTaskSessionSummary | null, data: Buffer): boolean {
	const interaction = summary?.outstandingInteraction;
	const inputByte = data.length === 1 ? data[0] : undefined;
	const isNumberedChoice =
		inputByte !== undefined && inputByte >= FIRST_NUMBERED_CHOICE && inputByte <= LAST_NUMBERED_CHOICE;
	const isCodexApprovalChoice = inputByte === LOWERCASE_Y || inputByte === UPPERCASE_Y || isNumberedChoice;
	if (summary?.agentId === "claude" && isNumberedChoice) {
		const target = resolveInteractionResponseTarget(summary, interaction ?? null);
		return target?.provider === "claude" && target.kind === "permission" && target.providerAgentId !== null;
	}
	if (summary?.agentId === "codex" && isCodexApprovalChoice) {
		const target = resolveInteractionResponseTarget(summary, interaction ?? null);
		if (target?.provider === "codex" && target.kind === "permission" && target.providerAgentId !== null) {
			return true;
		}
	}
	return (
		summary?.state === "awaiting_review" &&
		summary.agentId === "codex" &&
		interaction?.provider === "codex" &&
		interaction.kind === "permission" &&
		interaction.status === "waiting" &&
		isCodexApprovalChoice
	);
}

export interface InputPipelineDeps {
	getSummary: (taskId: string) => RuntimeTaskSessionSummary | null;
	getEntry: (taskId: string) => ProcessEntry | undefined;
	applyTransitionEvent: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
	onInterruptRecoveryScheduled?: (signal: InterruptSignal) => void;
	onInterruptRecoveryApplied?: (
		signal: InterruptSignal,
		result: (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null,
	) => void;
}

/**
 * Process user input for a session. Handles permission compatibility,
 * interrupt detection, and explicit response transitions around the PTY write.
 * Returns the current summary, or null if the session has no active process.
 */
export function processSessionInput(
	entry: ProcessEntry,
	taskId: string,
	data: Buffer,
	deps: InputPipelineDeps,
	options: TerminalSessionInputOptions = {},
): RuntimeTaskSessionSummary | null {
	if (!entry.active || entry.active.session.wasInterrupted()) {
		return null;
	}
	// Passive reports cannot answer an interaction or interrupt a turn. Keep the
	// write and its current detached return snapshot, without cloning the prior
	// summary or deriving actionable-input state. Explicit submit intent still
	// takes the ordinary semantic path, even when its bytes look like mouse input.
	const passiveMouseReport = isTerminalPassiveMouseReport(data);
	if (passiveMouseReport && options.explicitUserSubmission !== true) {
		entry.active.session.write(data);
		return deps.getSummary(taskId);
	}
	const summary = deps.getSummary(taskId);

	const protocolResponse = isTerminalProtocolResponse(data);
	// Wheel scrolling and pointer motion in fullscreen providers are not intent
	// to answer a trust dialog; keys and clicks take it over.
	if (!protocolResponse && !passiveMouseReport) cancelWorkspaceTrustForUserInput(entry.active);
	const explicitSubmission =
		!protocolResponse &&
		(options.explicitUserSubmission === true ||
			isExplicitUserSubmission(data) ||
			isImmediateInteractionSubmission(summary, data));
	const { isCtrlC, isBareEscape } = detectInterruptSignal(data);
	// A subagent prompt can need input while the foreground turn is still Running.
	const waitsForActionableInput = summary ? deriveTaskIndicatorState(summary).needsInput : false;
	const resolvesInputWait = waitsForActionableInput && (explicitSubmission || isCtrlC || isBareEscape);
	const recordsProviderSubmission =
		(summary?.agentId === "codex" || summary?.agentId === "claude" || summary?.agentId === "pi") && resolvesInputWait;
	const responseOccurredAt = resolvesInputWait ? Date.now() : null;
	// 1. Ctrl+C while running suppresses auto-restart and schedules recovery.
	//    Escape can dismiss provider UI; only provider evidence may establish
	//    that it interrupted a turn.
	if (summary?.state === "running" && isCtrlC) {
		entry.suppressAutoRestartOnExit = true;
		scheduleInterruptRecovery(entry, "ctrl_c", {
			getEntry: (id) => deps.getEntry(id),
			getSummary: (id) => deps.getSummary(id),
			applyTransitionEvent: (e, ev) => deps.applyTransitionEvent(e, ev),
			onRecoveryScheduled: deps.onInterruptRecoveryScheduled,
			onRecoveryApplied: deps.onInterruptRecoveryApplied,
		});
	}
	// Arm the adapter's bounded rendered-result detector before the write so
	// the provider's response frame is inspected. The detector, not Escape,
	// decides whether a turn was interrupted.
	if (isBareEscape && summary) {
		const escapeAt = Date.now();
		if (entry.active.agentId === "claude") recordClaudeInterruptKey(entry.hookEventOrder, escapeAt);
		entry.active.observeBareEscapeInput?.(summary, escapeAt);
	}

	// 2. PTY write. Only mark the response after it has been handed to the
	//    process; a failed write must not claim the wait was resolved.
	entry.active.session.write(data);

	// 3. Record the direct user submission as an ordering boundary.
	//    This prevents an older PermissionRequest that was delayed in transport
	//    from restoring the wait after the user already answered it.
	//    When a foreground and a subagent prompt both wait, the answer is routed
	//    to one of them, but either may have been on screen: fence both domains.
	if (recordsProviderSubmission) {
		const submittedAt = responseOccurredAt ?? Date.now();
		recordHookUserSubmission(
			entry.hookEventOrder,
			submittedAt,
			summary ? resolveInteractionResponseTarget(summary, summary.outstandingInteraction) : null,
		);
		const alternate = summary
			? resolveAlternateInteractionResponseTarget(summary, summary.outstandingInteraction)
			: null;
		if (alternate) recordHookUserSubmission(entry.hookEventOrder, submittedAt, alternate);
	}

	// 4. Record that the actionable wait received a response without claiming
	//    the provider resumed. Enter also accepts TUI-local actions such as model
	//    selection and permission menus, so only a current native hook may move
	//    the task to Running. Until then the canonical UI says the response was
	//    sent and confirmation is pending.
	if (resolvesInputWait) {
		deps.applyTransitionEvent(entry, {
			type: "interaction.response_submitted",
			responseKind: isCtrlC || isBareEscape ? "cancel" : "submit",
			occurredAt: responseOccurredAt ?? Date.now(),
		});
	}
	return deps.getSummary(taskId);
}
