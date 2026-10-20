import type { RuntimeHookMetadata } from "../core";

/** Native navigation identifies the foreground chat even before Codex exposes its transcript. */
export function isCodexForegroundSessionStart(metadata: RuntimeHookMetadata | undefined): boolean {
	if (
		metadata?.source?.trim().toLowerCase() !== "codex" ||
		metadata.hookEventName?.trim().toLowerCase() !== "sessionstart" ||
		metadata.providerAgentId?.trim()
	) {
		return false;
	}
	return (
		metadata.sessionStartSource === "startup" ||
		metadata.sessionStartSource === "resume" ||
		metadata.sessionStartSource === "clear" ||
		Boolean(metadata.transcriptPath?.trim() || metadata.sessionStartHasTranscript)
	);
}
