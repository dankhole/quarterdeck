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
 * During a multi-step rebase, resolved files and reviewed auto-merged files
 * should reset when the rebase advances to the next commit. This returns
 * `true` when both previous and current steps are non-null and differ.
 */
export function shouldResetOnStepChange(previousStep: number | null, currentStep: number | null): boolean {
	return previousStep !== null && currentStep !== null && currentStep !== previousStep;
}

/**
 * Filter conflicted file paths to only those not yet resolved.
 */
export function filterUnresolvedPaths(
	conflictedFiles: readonly string[],
	resolvedFiles: ReadonlySet<string>,
): string[] {
	return conflictedFiles.filter((f) => !resolvedFiles.has(f));
}

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
// Fallback responses (when no workspace is available)
// ---------------------------------------------------------------------------

export function buildNoWorkspaceContinueResponse(): RuntimeConflictContinueResponse {
	return { ok: false, completed: false, summary: EMPTY_GIT_SYNC_SUMMARY, output: "" };
}

export function buildNoWorkspaceAbortResponse(): RuntimeConflictAbortResponse {
	return { ok: false, summary: EMPTY_GIT_SYNC_SUMMARY };
}
