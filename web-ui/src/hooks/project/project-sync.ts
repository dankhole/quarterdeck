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

export interface CachedProjectBoardRestore {
	projectId: string;
	authoritativeRevision: number;
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
 * Decide how the authoritative board should affect the currently displayed UI.
 *
 * - `"hydrate"`: replace the displayed board with the authoritative board
 * - `"confirm_cache"`: keep the currently displayed cached board, but promote
 *   the project back to authoritative mode because the server confirmed the
 *   cached revision
 * - `"skip"`: keep the current board because we already have this exact
 *   authoritative revision applied
 */
export function resolveAuthoritativeBoardAction(
	currentVersion: ProjectVersion,
	currentProjectId: string | null,
	incomingRevision: number,
	cachedRestore: CachedProjectBoardRestore | null,
): "hydrate" | "confirm_cache" | "skip" {
	const isSameProject = currentVersion.projectId === currentProjectId;
	const currentRevision = isSameProject ? currentVersion.revision : null;
	if (isSameProject && currentRevision !== null) {
		return currentRevision === incomingRevision ? "skip" : "hydrate";
	}
	if (
		currentProjectId &&
		cachedRestore?.projectId === currentProjectId &&
		cachedRestore.authoritativeRevision === incomingRevision
	) {
		return "confirm_cache";
	}
	return "hydrate";
}
