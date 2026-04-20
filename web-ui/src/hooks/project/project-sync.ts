/**
 * Pure domain logic for project state synchronization.
 *
 * No React imports — functions here take explicit parameters and return
 * plain data. The companion hook (`use-project-sync.ts`) handles React
 * state, effects, and async fetching.
 */

import { createInitialBoardData } from "@/data/board-data";
import { projectBoardWithSessionColumns } from "@/hooks/board/session-column-sync";
import type { RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import { normalizeBoardData } from "@/state/board-state";
import type { BoardData } from "@/types";
import { reconcileAuthoritativeTaskSessionSummaryMap } from "@/utils/session-summary-utils";

export interface ProjectBoardSessionsState {
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
}

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

export interface ResolveAuthoritativeProjectStateApplyInput {
	currentState: ProjectBoardSessionsState;
	currentVersion: ProjectVersion;
	currentProjectId: string | null;
	incomingProjectState: RuntimeProjectStateResponse;
	cachedRestore: CachedProjectBoardRestore | null;
}

export interface AuthoritativeProjectStateApplyResult {
	nextState: ProjectBoardSessionsState;
	boardAction: "hydrate" | "confirm_cache" | "skip";
	shouldBumpHydrationNonce: boolean;
	shouldSkipPersistOnHydration: boolean;
	boardForCache: BoardData;
}

/**
 * The one browser-side entry point for authoritative project state.
 *
 * Keep this pipeline atomic. Future changes should extend this function rather
 * than re-deriving parts of the apply from separate snapshots in the hook.
 *
 * Invariants:
 * - Reconcile authoritative sessions against the latest local session state.
 * - Derive board projection from that reconciled session set, not from raw
 *   incoming snapshot sessions.
 * - Treat cached revision confirmation as subordinate to runtime session truth:
 *   same-revision authoritative refreshes may still need to re-project the
 *   displayed board.
 * - Drive hydration policy, cache updates, and revision re-entry from this same
 *   apply result so authoritative replacement does not drift back into
 *   incidental ordering.
 */
export function applyAuthoritativeProjectState(
	input: ResolveAuthoritativeProjectStateApplyInput,
): AuthoritativeProjectStateApplyResult | null {
	if (
		shouldApplyProjectUpdate(input.currentVersion, input.currentProjectId, input.incomingProjectState.revision) ===
		"skip"
	) {
		return null;
	}

	const reconciledSessions = reconcileAuthoritativeTaskSessionSummaries(
		input.currentState.sessions,
		input.incomingProjectState.sessions ?? {},
	);
	const normalizedBoard = normalizeBoardData(input.incomingProjectState.board) ?? createInitialBoardData();
	const authoritativeBoard = applyAuthoritativeProjectBoard(normalizedBoard, reconciledSessions);
	const currentProjectedBoard = applyAuthoritativeProjectBoard(input.currentState.board, reconciledSessions);
	const boardAction = resolveAuthoritativeBoardAction(
		input.currentVersion,
		input.currentProjectId,
		input.incomingProjectState.revision,
		input.cachedRestore,
	);
	const resolvedBoard = boardAction === "hydrate" ? authoritativeBoard : currentProjectedBoard;

	return {
		nextState: {
			board: resolvedBoard.board,
			sessions: reconciledSessions,
		},
		boardAction,
		shouldBumpHydrationNonce: boardAction === "hydrate" || !currentProjectedBoard.shouldSkipPersistOnHydration,
		shouldSkipPersistOnHydration: resolvedBoard.shouldSkipPersistOnHydration,
		boardForCache: resolvedBoard.board,
	};
}
