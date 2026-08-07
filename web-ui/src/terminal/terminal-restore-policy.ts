import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function shouldForceResizeBeforeRestore(agentId: RuntimeTaskSessionSummary["agentId"] | null): boolean {
	return agentId === "claude" || agentId === "codex";
}

export function shouldSkipEmptyRestoreSnapshot(snapshot: string, currentLines: readonly string[]): boolean {
	return snapshot.length === 0 && currentLines.some((line) => line.trim().length > 0);
}
