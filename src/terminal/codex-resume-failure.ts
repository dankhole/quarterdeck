import type { RuntimeTaskSessionSummary } from "../core";

const LEGACY_RESUME_FAILURE_WARNING = "Resume failed before opening an interactive session";

export const STORED_CODEX_RESUME_FAILED_WARNING =
	"Could not resume the stored Codex session. Quarterdeck will fall back to the most recent Codex session for this checkout on the next restart.";

export function isResumeFailureWarning(message: string | null | undefined): boolean {
	return (
		typeof message === "string" &&
		(message.includes(LEGACY_RESUME_FAILURE_WARNING) || message === STORED_CODEX_RESUME_FAILED_WARNING)
	);
}

export function isCodexResumeFailureSummary(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	return (
		summary?.agentId === "codex" &&
		summary.state === "awaiting_review" &&
		summary.reviewReason === "error" &&
		isResumeFailureWarning(summary.warningMessage)
	);
}

export function hasFailedStoredCodexResume(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	return (
		summary != null &&
		isCodexResumeFailureSummary(summary) &&
		typeof summary.resumeSessionId === "string" &&
		summary.resumeSessionId.trim().length > 0
	);
}
