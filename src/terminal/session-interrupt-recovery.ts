// Interrupt signal detection and recovery scheduling.
// Extracted from session-manager.ts — detects Ctrl+C/Escape in user input
// and schedules a timer to transition the session back to review if the
// agent doesn't resume working within the recovery window.

import type { RuntimeTaskSessionSummary } from "../core";
import { emitSessionEvent } from "../core";
import type { ActiveProcessState, ProcessEntry } from "./session-manager-types";
import type { SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";

export const INTERRUPT_RECOVERY_DELAY_MS = 5_000;
export const SIGINT_BYTE = 0x03;
export const ESC_BYTE = 0x1b;
// Real Ctrl+C arrives as a 1–3 byte sequence; larger buffers are likely pasted text.
export const MAX_SIGINT_DETECT_BUFFER_SIZE = 4;

export function clearInterruptRecoveryTimer(active: ActiveProcessState): void {
	if (active.interruptRecoveryTimer) {
		clearTimeout(active.interruptRecoveryTimer);
		active.interruptRecoveryTimer = null;
	}
}

/** Detect whether the input buffer contains an interrupt signal (Ctrl+C or bare Escape). */
export function detectInterruptSignal(data: Buffer): { isCtrlC: boolean; isBareEscape: boolean } {
	return {
		isCtrlC: data.length <= MAX_SIGINT_DETECT_BUFFER_SIZE && data.includes(SIGINT_BYTE),
		isBareEscape: data.length === 1 && data[0] === ESC_BYTE,
	};
}

export interface InterruptRecoveryContext {
	getEntry: (taskId: string) => ProcessEntry | undefined;
	getSummary: (taskId: string) => RuntimeTaskSessionSummary | null;
	applySessionEventWithSideEffects: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
}

/**
 * Schedule interrupt recovery: sets a timer that will transition the session
 * to awaiting_review/attention if the agent doesn't resume within the delay.
 */
export function scheduleInterruptRecovery(entry: ProcessEntry, ctx: InterruptRecoveryContext): void {
	if (!entry.active) {
		return;
	}
	clearInterruptRecoveryTimer(entry.active);
	const taskId = entry.taskId;
	emitSessionEvent(taskId, "interrupt_recovery.scheduled", {});
	entry.active.interruptRecoveryTimer = setTimeout(() => {
		const current = ctx.getEntry(taskId);
		if (!current?.active) {
			return;
		}
		current.active.interruptRecoveryTimer = null;
		const summary = ctx.getSummary(taskId);
		if (summary?.state !== "running") {
			return;
		}
		emitSessionEvent(taskId, "interrupt_recovery.fired", {
			currentState: summary.state,
		});
		// Always transition — even if the agent produced output after the interrupt
		// (e.g. Claude redraws its prompt after Escape). If the agent is genuinely
		// still working, its next hook will move the card back to running.
		ctx.applySessionEventWithSideEffects(current, { type: "interrupt.recovery" });
	}, INTERRUPT_RECOVERY_DELAY_MS);
}
