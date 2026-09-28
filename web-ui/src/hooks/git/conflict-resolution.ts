/**
 * Pure domain logic for conflict resolution operations.
 *
 * No React imports — functions here take explicit parameters and return
 * plain data. The companion hook (`use-conflict-resolution.ts`) handles
 * React state, effects, and tRPC mutations.
 */

import type {
	RuntimeConflictAbortResponse,
	RuntimeConflictContinueResponse,
	RuntimeGitSyncSummary,
} from "@/runtime/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMPTY_GIT_SYNC_SUMMARY: RuntimeGitSyncSummary = {
	currentBranch: null,
	upstreamBranch: null,
	changedFiles: 0,
	additions: 0,
	deletions: 0,
	aheadCount: 0,
	behindCount: 0,
};

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

/**
 * Detect files that were externally resolved (e.g. by the agent or another
 * tool) between metadata polls. Returns the paths that were present in the
 * previous conflict state but absent in the current one.
 */
export function detectExternallyResolvedFiles(
	previousFiles: readonly string[],
	currentFiles: readonly string[],
): string[] {
	if (previousFiles.length === 0 || currentFiles.length >= previousFiles.length) {
		return [];
	}
	const currentSet = new Set(currentFiles);
	return previousFiles.filter((f) => !currentSet.has(f));
}

// ---------------------------------------------------------------------------
// Fallback responses (when no project is available)
// ---------------------------------------------------------------------------

export function buildNoWorktreeContinueResponse(): RuntimeConflictContinueResponse {
	return { ok: false, completed: false, summary: EMPTY_GIT_SYNC_SUMMARY, output: "" };
}

export function buildNoWorktreeAbortResponse(): RuntimeConflictAbortResponse {
	return { ok: false, summary: EMPTY_GIT_SYNC_SUMMARY };
}
