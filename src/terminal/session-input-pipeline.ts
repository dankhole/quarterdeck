// Input routing pipeline for PTY sessions.
// Extracted from session-manager.ts — processes user keyboard input through
// an ordered pipeline: terminal protocol response detection → permission
// activity clearing → Codex prompt flagging → interrupt detection → PTY write.

import type { RuntimeTaskSessionSummary } from "../core";
import { emitSessionEvent } from "../core";
import { detectInterruptSignal, scheduleInterruptRecovery } from "./session-interrupt-recovery";
import type { ProcessEntry } from "./session-manager-types";
import { isPermissionActivity } from "./session-reconciliation";
import type { SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";

const ESC = 0x1b;
const CSI_BRACKET = 0x5b; // [

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

export interface InputPipelineDeps {
	getSummary: (taskId: string) => RuntimeTaskSessionSummary | null;
	updateStore: (taskId: string, patch: Partial<RuntimeTaskSessionSummary>) => RuntimeTaskSessionSummary | null;
	getEntry: (taskId: string) => ProcessEntry | undefined;
	applySessionEventWithSideEffects: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
}

/**
 * Process user input for a session. Handles permission activity clearing,
 * Codex prompt flagging, and interrupt detection before writing to the PTY.
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

	// 1. Permission activity clearing — when the user types into a permission
	//    prompt, clear the metadata so hooks can transition the task back to running.
	//    Skip terminal protocol responses (focus events, cursor reports) that xterm.js
	//    sends automatically.
	if (
		summary?.state === "awaiting_review" &&
		summary.latestHookActivity != null &&
		isPermissionActivity(summary.latestHookActivity) &&
		!isTerminalProtocolResponse(data)
	) {
		deps.updateStore(taskId, { latestHookActivity: null });
	}

	// 2. Codex Enter detection — flag when the user presses Enter during review
	//    so the output handler knows to watch for a prompt transition.
	//    Only trigger on CR (byte 13 = Enter), not LF (byte 10 = Shift+Enter newline).
	if (
		summary?.agentId === "codex" &&
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "hook" || summary.reviewReason === "attention" || summary.reviewReason === "error") &&
		data.includes(13)
	) {
		entry.active.awaitingCodexPromptAfterEnter = true;
		emitSessionEvent(taskId, "writeInput.codex_flag", {
			currentState: summary.state,
			reviewReason: summary.reviewReason,
		});
	}

	// 3. Interrupt detection — Ctrl+C or bare Escape while running suppresses
	//    auto-restart and schedules a recovery timer.
	const { isCtrlC, isBareEscape } = detectInterruptSignal(data);
	if (summary?.state === "running" && (isCtrlC || isBareEscape)) {
		emitSessionEvent(taskId, "writeInput.interrupt", {
			isCtrlC,
			isBareEscape,
			currentState: summary.state,
		});
		entry.suppressAutoRestartOnExit = true;
		scheduleInterruptRecovery(entry, {
			getEntry: (id) => deps.getEntry(id),
			getSummary: (id) => deps.getSummary(id),
			applySessionEventWithSideEffects: (e, ev) => deps.applySessionEventWithSideEffects(e, ev),
		});
	}

	// 4. PTY write
	entry.active.session.write(data);
	return deps.getSummary(taskId);
}
