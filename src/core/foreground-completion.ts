import type { RuntimeHookEvent, RuntimeHookMetadata } from "./api/task-session.js";

/** The native foreground replies retained by both live ingest and recovery. */
export function isForegroundCompletionHook(
	event: RuntimeHookEvent,
	metadata: RuntimeHookMetadata | undefined,
): boolean {
	if (metadata?.providerAgentId?.trim()) return false;
	const source = metadata?.source?.trim().toLowerCase();
	const hookEventName = metadata?.hookEventName?.trim().toLowerCase();
	return (
		((source === "codex" || source === "claude") && event === "to_review" && hookEventName === "stop") ||
		(source === "pi" &&
			((event === "to_review" && hookEventName === "agentsettled") ||
				// The reply is complete even while background work defers Review.
				(event === "activity" && hookEventName === "agentsettledbackgroundpending")))
	);
}
