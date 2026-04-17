/**
 * Pure domain logic for project state synchronization.
 *
 * No React imports — functions here take explicit parameters and return
 * plain data. The companion hook (`use-project-sync.ts`) handles React
 * state, effects, and async fetching.
 */

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { selectNewestTaskSessionSummary } from "@/utils/session-summary-utils";

// ---------------------------------------------------------------------------
// Session merging
// ---------------------------------------------------------------------------

/**
 * Merge incoming task session summaries into the current set, keeping the
 * newest summary for each task (by startedAt timestamp). This prevents
 * stale session replays from overwriting newer running sessions.
 */
export function mergeTaskSessionSummaries(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	nextSessions: Record<string, RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	const merged = { ...currentSessions };
	for (const [taskId, summary] of Object.entries(nextSessions)) {
		const newest = selectNewestTaskSessionSummary(merged[taskId] ?? null, summary);
		if (newest) {
			merged[taskId] = newest;
		}
	}
	return merged;
}

// ---------------------------------------------------------------------------
// Revision tracking
// ---------------------------------------------------------------------------

export interface ProjectVersion {
	projectId: string | null;
	revision: number | null;
}

/**
 * Determine whether an incoming project state update should be applied,
 * based on the current version tracking state.
 *
 * Returns `"skip"` if the incoming revision is older than what we already
 * have, meaning the update should be silently ignored.
 * Returns `"apply"` if the update should be applied (newer or first load).
 */
export function shouldApplyProjectUpdate(
	currentVersion: ProjectVersion,
	currentProjectId: string | null,
	incomingRevision: number,
): "apply" | "skip" {
	const isSameProject = currentVersion.projectId === currentProjectId;
	const currentRevision = isSameProject ? currentVersion.revision : null;
	if (isSameProject && currentRevision !== null && incomingRevision < currentRevision) {
		return "skip";
	}
	return "apply";
}

/**
 * Determine whether the board data should be replaced from the incoming
 * project state (full hydration), or whether only sessions should be
 * merged. Board hydration happens on:
 * - First load for a project (different project ID)
 * - Revision change (someone else saved while we weren't looking)
 */
export function shouldHydrateBoard(
	currentVersion: ProjectVersion,
	currentProjectId: string | null,
	incomingRevision: number,
): boolean {
	const isSameProject = currentVersion.projectId === currentProjectId;
	const currentRevision = isSameProject ? currentVersion.revision : null;
	return !isSameProject || currentRevision !== incomingRevision;
}
