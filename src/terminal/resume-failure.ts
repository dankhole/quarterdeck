import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "../core";

const LEGACY_RESUME_FAILURE_WARNING = "Resume failed before opening an interactive session";

/** A resume whose provider exited cleanly before it opened an interactive session. */
export const RESUME_EXITED_BEFORE_INTERACTIVE_SESSION_WARNING =
	"Resume exited before opening an interactive session; no replacement prompt was replayed.";

export const STORED_CODEX_RESUME_FAILED_WARNING =
	"Could not resume the stored Codex session. Quarterdeck will fall back to the most recent Codex session for this checkout on the next restart.";

export const STORED_CLAUDE_RESUME_FAILED_WARNING =
	"Could not resume the stored Claude session. Quarterdeck will fall back to the most recent Claude session for this checkout on the next restart.";

export const STORED_PI_RESUME_FAILED_WARNING =
	"Could not resume the stored Pi session. Quarterdeck will fall back to the most recent Pi session for this checkout on the next explicit restart.";

export const STORED_OPENCODE_RESUME_FAILED_WARNING =
	"Could not resume the stored opencode session. Quarterdeck will fall back to the most recent opencode session for this checkout on the next explicit restart.";

const STORED_RESUME_FAILED_WARNINGS: ReadonlyMap<string, string> = new Map<RuntimeAgentId, string>([
	["codex", STORED_CODEX_RESUME_FAILED_WARNING],
	["claude", STORED_CLAUDE_RESUME_FAILED_WARNING],
	["pi", STORED_PI_RESUME_FAILED_WARNING],
	["opencode", STORED_OPENCODE_RESUME_FAILED_WARNING],
]);
const STORED_RESUME_FAILED_WARNING_MESSAGES: ReadonlySet<string> = new Set(STORED_RESUME_FAILED_WARNINGS.values());

/** The warning recorded when an agent's exact stored-id resume fails, or null for agents without targeted resume. */
export function getStoredResumeFailedWarning(agentId: string | null | undefined): string | null {
	return agentId ? (STORED_RESUME_FAILED_WARNINGS.get(agentId) ?? null) : null;
}

/** A resume whose provider exited non-zero before opening an interactive session. */
function isNonZeroResumeFailureWarning(message: string | null | undefined): boolean {
	return (
		typeof message === "string" &&
		(message.includes(LEGACY_RESUME_FAILURE_WARNING) || STORED_RESUME_FAILED_WARNING_MESSAGES.has(message))
	);
}

export function isResumeFailureWarning(message: string | null | undefined): boolean {
	return isNonZeroResumeFailureWarning(message) || message === RESUME_EXITED_BEFORE_INTERACTIVE_SESSION_WARNING;
}

function isErrorReview(summary: RuntimeTaskSessionSummary | null | undefined): summary is RuntimeTaskSessionSummary {
	return summary != null && summary.state === "awaiting_review" && summary.reviewReason === "error";
}

/**
 * A resume that failed before opening an interactive session. Retrying it
 * automatically would repeat the same failure (or silently open a different
 * conversation), so only an explicit user restart may follow it.
 */
export function isResumeFailureSummary(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	return isErrorReview(summary) && isResumeFailureWarning(summary.warningMessage);
}

/**
 * A non-zero failed resume that still carries the exact stored provider
 * session id it could not open. A clean pre-interactive exit keeps its id
 * usable for the next explicit restart.
 */
export function hasFailedStoredResume(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	return (
		isErrorReview(summary) &&
		getStoredResumeFailedWarning(summary.agentId) !== null &&
		isNonZeroResumeFailureWarning(summary.warningMessage) &&
		typeof summary.resumeSessionId === "string" &&
		summary.resumeSessionId.trim().length > 0
	);
}
