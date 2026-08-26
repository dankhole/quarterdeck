// Interrupt signal detection and recovery scheduling.
// Extracted from session-manager.ts — detects Ctrl+C/Escape in user input
// and schedules a timer to transition the session back to review if the
// agent doesn't resume working within the recovery window.

import type { RuntimeTaskSessionSummary } from "../core";
import type { ActiveProcessState, ProcessEntry } from "./session-manager-types";
import type { SessionTransitionEvent, SessionTransitionResult } from "./session-summary-store";

export const INTERRUPT_RECOVERY_DELAY_MS = 5_000;
export const SIGINT_BYTE = 0x03;
export const ESC_BYTE = 0x1b;
// Real Ctrl+C arrives as a 1–3 byte sequence; larger buffers are likely pasted text.
export const MAX_SIGINT_DETECT_BUFFER_SIZE = 4;
export type InterruptSignal = "ctrl_c" | "escape";

export function clearInterruptRecoveryTimer(active: ActiveProcessState): void {
	if (active.interruptRecoveryTimer) {
		clearTimeout(active.interruptRecoveryTimer);
		active.interruptRecoveryTimer = null;
	}
	active.interruptRecoveryStartedAt = null;
	active.interruptRecoverySignal = null;
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
	applyTransitionEvent: (
		entry: ProcessEntry,
		event: SessionTransitionEvent,
	) => (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null;
	onRecoveryScheduled?: (signal: InterruptSignal) => void;
	onRecoveryApplied?: (
		signal: InterruptSignal,
		result: (SessionTransitionResult & { summary: RuntimeTaskSessionSummary }) | null,
	) => void;
}

/**
 * Remove the public Running claim immediately when the user asks the TUI to
 * interrupt, then retain a short launch-scoped fence while provider evidence
 * or process exit settles the outcome. The timer only retires that transient
 * fence; it is never the ordinary author of user-visible task meaning.
 */
export function scheduleInterruptRecovery(
	entry: ProcessEntry,
	signal: InterruptSignal,
	ctx: InterruptRecoveryContext,
): void {
	if (!entry.active) {
		return;
	}
	clearInterruptRecoveryTimer(entry.active);
	ctx.onRecoveryScheduled?.(signal);
	const taskId = entry.taskId;
	entry.active.interruptRecoveryStartedAt = Date.now();
	entry.active.interruptRecoverySignal = signal;
	const result = ctx.applyTransitionEvent(entry, { type: "interrupt.recovery" });
	ctx.onRecoveryApplied?.(signal, result);
	entry.active.interruptRecoveryTimer = setTimeout(() => {
		const current = ctx.getEntry(taskId);
		if (!current?.active) {
			return;
		}
		current.active.interruptRecoveryTimer = null;
		current.active.interruptRecoveryStartedAt = null;
		current.active.interruptRecoverySignal = null;
	}, INTERRUPT_RECOVERY_DELAY_MS);
}
