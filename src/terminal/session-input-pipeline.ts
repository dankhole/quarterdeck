// Input routing pipeline for PTY sessions.
// Extracted from session-manager.ts — processes user keyboard input through
// an ordered pipeline: terminal protocol response detection → interrupt
// detection → PTY write → provider-ordering fence.

import { deriveTaskIndicatorState, type RuntimeTaskSessionSummary } from "../core";
import { recordHookUserSubmission } from "./hook-event-order";
import { detectInterruptSignal, type InterruptSignal, scheduleInterruptRecovery } from "./session-interrupt-recovery";
import type { ProcessEntry } from "./session-manager-types";
import type { SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";
import type { TerminalSessionInputOptions } from "./terminal-session-service";

const ESC = 0x1b;
const CSI_BRACKET = 0x5b; // [
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
 */
export function isTerminalProtocolResponse(data: Buffer): boolean {
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
		for (let i = 2; i < data.length - 1; i++) {
			const byte = data[i] as number;
			if (byte !== 0x3b /* ; */ && (byte < 0x30 || byte > 0x39) /* 0-9 */) {
				return false;
			}
		}
		return true;
	}
	return false;
}

/** A normal Enter submission. Shift+Enter/newline remains ordinary editing. */
export function isExplicitUserSubmission(data: Buffer): boolean {
	return data.length === 1 && data[0] === CARRIAGE_RETURN;
}

/**
 * Codex approval panes expose `y` and numbered rows as immediate actions: the
 * TUI acts on those bytes without waiting for Enter. Recognize them only for
 * the exact foreground permission interaction already owned by the current
 * Codex session. Arbitrary terminal bytes, question text, and other providers
 * remain ordinary input and cannot manufacture a semantic response boundary.
 */
export function isImmediateInteractionSubmission(summary: RuntimeTaskSessionSummary | null, data: Buffer): boolean {
	const interaction = summary?.outstandingInteraction;
	const inputByte = data.length === 1 ? data[0] : undefined;
	const isCodexApprovalChoice =
		inputByte === LOWERCASE_Y ||
		inputByte === UPPERCASE_Y ||
		(inputByte !== undefined && inputByte >= FIRST_NUMBERED_CHOICE && inputByte <= LAST_NUMBERED_CHOICE);
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
	const summary = deps.getSummary(taskId);

	const protocolResponse = isTerminalProtocolResponse(data);
	const explicitSubmission =
		!protocolResponse &&
		(options.explicitUserSubmission === true ||
			isExplicitUserSubmission(data) ||
			isImmediateInteractionSubmission(summary, data));
	const { isCtrlC, isBareEscape } = detectInterruptSignal(data);
	const waitsForActionableInput = summary?.state === "awaiting_review" && deriveTaskIndicatorState(summary).needsInput;
	const resolvesInputWait = waitsForActionableInput && (explicitSubmission || isCtrlC || isBareEscape);
	const recordsProviderSubmission =
		(summary?.agentId === "codex" || summary?.agentId === "claude" || summary?.agentId === "pi") && resolvesInputWait;
	const responseOccurredAt = resolvesInputWait ? Date.now() : null;
	// 1. Interrupt detection — Ctrl+C or bare Escape while running suppresses
	//    auto-restart and schedules a recovery timer.
	if (summary?.state === "running" && (isCtrlC || isBareEscape)) {
		const interruptSignal: InterruptSignal = isCtrlC ? "ctrl_c" : "escape";
		entry.suppressAutoRestartOnExit = true;
		scheduleInterruptRecovery(entry, interruptSignal, {
			getEntry: (id) => deps.getEntry(id),
			getSummary: (id) => deps.getSummary(id),
			applyTransitionEvent: (e, ev) => deps.applyTransitionEvent(e, ev),
			onRecoveryScheduled: deps.onInterruptRecoveryScheduled,
			onRecoveryApplied: deps.onInterruptRecoveryApplied,
		});
	}

	// 2. PTY write. Only mark the response after it has been handed to the
	//    process; a failed write must not claim the wait was resolved.
	entry.active.session.write(data);

	// 3. Record the direct user submission as an ordering boundary.
	//    This prevents an older PermissionRequest that was delayed in transport
	//    from restoring the wait after the user already answered it.
	if (recordsProviderSubmission) {
		recordHookUserSubmission(
			entry.hookEventOrder,
			responseOccurredAt ?? Date.now(),
			summary?.outstandingInteraction ?? null,
		);
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
