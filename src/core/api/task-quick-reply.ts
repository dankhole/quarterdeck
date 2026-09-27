import { deriveTaskIndicatorState } from "./task-indicators.js";
import type { RuntimeTaskSessionSummary } from "./task-session.js";

/** A board reply targets an ordinary, live agent prompt, never an approval or a replacement PTY. */
export function canSendTaskQuickReply(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	return Boolean(
		summary?.pid != null &&
			(summary.agentId === "codex" || summary.agentId === "claude" || summary.agentId === "pi") &&
			summary.sessionInstanceId &&
			!summary.outstandingInteraction &&
			deriveTaskIndicatorState(summary).kind === "review_ready",
	);
}

export const TASK_QUICK_REPLY_MAX_LENGTH = 8_000;
