// Input routing pipeline for PTY sessions.
// Extracted from session-manager.ts — processes user keyboard input through
// an ordered pipeline: terminal protocol response detection → interrupt
// detection → PTY write → explicit user-response transition.

import { deriveTaskIndicatorState, type RuntimeTaskSessionSummary } from "../core";
import { recordHookUserSubmission } from "./hook-event-order";
import { detectInterruptSignal, scheduleInterruptRecovery } from "./session-interrupt-recovery";
import type { ProcessEntry } from "./session-manager-types";
import { isPermissionActivity } from "./session-reconciliation";
import type { SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";

const ESC = 0x1b;
const CSI_BRACKET = 0x5b; // [
const CARRIAGE_RETURN = 0x0d;

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

export interface InputPipelineDeps {
	getSummary: (taskId: string) => RuntimeTaskSessionSummary | null;
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
	getEntry: (taskId: string) => ProcessEntry | undefined;
	applyTransitionEvent: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
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
): RuntimeTaskSessionSummary | null {
	if (!entry.active) {
		return null;
	}
	const summary = deps.getSummary(taskId);

	const protocolResponse = isTerminalProtocolResponse(data);
	const explicitSubmission = !protocolResponse && isExplicitUserSubmission(data);
	const resolvesInputWait =
		explicitSubmission && summary?.state === "awaiting_review" && deriveTaskIndicatorState(summary).needsInput;
	const clearsNonCodexPermission =
		summary?.agentId !== "codex" &&
		summary?.state === "awaiting_review" &&
		isPermissionActivity(summary.latestHookActivity) &&
		!protocolResponse &&
		!explicitSubmission;
	if (clearsNonCodexPermission) {
		// Claude and Pi can resolve permission menus with a single keypress and
		// rely on the following native hook to confirm running. Preserve that
		// behavior while Codex uses its source-specific PostToolUse guard.
		deps.updateStore(taskId, { latestHookActivity: null });
	}

	// 1. Interrupt detection — Ctrl+C or bare Escape while running suppresses
	//    auto-restart and schedules a recovery timer.
	const { isCtrlC, isBareEscape } = detectInterruptSignal(data);
	if (summary?.state === "running" && (isCtrlC || isBareEscape)) {
		entry.suppressAutoRestartOnExit = true;
		scheduleInterruptRecovery(entry, {
			getEntry: (id) => deps.getEntry(id),
			getSummary: (id) => deps.getSummary(id),
			applyTransitionEvent: (e, ev) => deps.applyTransitionEvent(e, ev),
		});
	}

	// 2. PTY write. Only mark the response after it has been handed to the
	//    process; a failed write must not claim the wait was resolved.
	entry.active.session.write(data);

	// 3. Record the direct user submission as an ordering boundary for Codex.
	//    This prevents an older PermissionRequest that was delayed in transport
	//    from restoring the wait after the user already answered it.
	if (explicitSubmission && summary?.agentId === "codex") {
		recordHookUserSubmission(entry.hookEventOrder);
	}

	// 4. A submitted response to an actionable input wait is authoritative user
	//    interaction. Route it through the state machine; ordinary review cards,
	//    cursor navigation, terminal protocol traffic, and PTY output do not move.
	if (resolvesInputWait) {
		deps.applyTransitionEvent(entry, { type: "user.responded" });
	}
	return deps.getSummary(taskId);
}
