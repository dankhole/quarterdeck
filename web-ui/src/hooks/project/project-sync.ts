/**
 * Pure domain logic for project state synchronization.
 *
 * No React imports — functions here take explicit parameters and return
 * plain data. The companion hook (`use-project-sync.ts`) handles React
 * state, effects, and async fetching.
 */

import { projectBoardWithSessionColumns } from "@/hooks/board/session-column-sync";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardData } from "@/types";
import {
	reconcileAuthoritativeTaskSessionSummaryMap,
} from "@/utils/session-summary-utils";

export function reconcileAuthoritativeTaskSessionSummaries(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	nextSessions: Record<string, RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	return reconcileAuthoritativeTaskSessionSummaryMap(currentSessions, nextSessions);
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

export interface AuthoritativeProjectBoardApplyResult {
	board: BoardData;
	shouldSkipPersistOnHydration: boolean;
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
 *   cached revision. The caller may still need to re-project runtime session
 *   truth onto the currently displayed board.
 * - `"skip"`: keep the current board because we already have this exact
 *   authoritative revision applied. The caller may still need to re-project
 *   runtime session truth onto the currently displayed board.
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

export function applyAuthoritativeProjectBoard(
	board: BoardData,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): AuthoritativeProjectBoardApplyResult {
	const projected = projectBoardWithSessionColumns(board, Object.values(sessions));
	return {
		board: projected.board,
		shouldSkipPersistOnHydration: !projected.changed,
	};
}
