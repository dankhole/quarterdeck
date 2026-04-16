/**
 * Pure domain logic for git actions (sync, branch switch, task git actions).
 *
 * No React imports — functions here take explicit parameters and return
 * plain data. The companion hook (`use-git-actions.ts`) handles React
 * state, effects, and tRPC mutations.
 */

import type { RuntimeGitSyncAction, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import type { BoardCard } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskGitActionSource = "card" | "agent";

export interface TaskGitActionLoadingState {
	commitSource: TaskGitActionSource | null;
	prSource: TaskGitActionSource | null;
}

export interface GitActionErrorState {
	action: RuntimeGitSyncAction;
	message: string;
	output: string;
	dirtyTree?: boolean;
}

// ---------------------------------------------------------------------------
// Workspace info matching
// ---------------------------------------------------------------------------

/**
 * Check whether cached workspace info matches the currently selected card.
 * Returns a type-narrowed `RuntimeTaskWorkspaceInfoResponse` when it matches.
 */
export function matchesWorkspaceInfoSelection(
	workspaceInfo: RuntimeTaskWorkspaceInfoResponse | null,
	card: BoardCard | null,
): workspaceInfo is RuntimeTaskWorkspaceInfoResponse {
	if (!workspaceInfo || !card) {
		return false;
	}
	return workspaceInfo.taskId === card.id && workspaceInfo.baseRef === card.baseRef;
}

// ---------------------------------------------------------------------------
// Loading state derivation
// ---------------------------------------------------------------------------

/**
 * Derive a `Record<taskId, true>` from the loading map for a specific
 * action type and source combination.
 */
export function deriveLoadingByTaskId(
	loadingByTaskId: Record<string, TaskGitActionLoadingState>,
	actionKey: "commitSource" | "prSource",
	source: TaskGitActionSource,
): Record<string, boolean> {
	const result: Record<string, boolean> = {};
	for (const [taskId, loading] of Object.entries(loadingByTaskId)) {
		if (loading[actionKey] === source) {
			result[taskId] = true;
		}
	}
	return result;
}

/**
 * Compute the next loading state map after setting a specific action's
 * source for a task. Returns `null` when the state didn't change.
 */
export function computeNextTaskGitActionLoading(
	current: Record<string, TaskGitActionLoadingState>,
	taskId: string,
	actionKey: "commitSource" | "prSource",
	source: TaskGitActionSource | null,
): Record<string, TaskGitActionLoadingState> | null {
	const existing = current[taskId] ?? { commitSource: null, prSource: null };
	if (existing[actionKey] === source) {
		return null;
	}
	const nextEntry: TaskGitActionLoadingState = {
		...existing,
		[actionKey]: source,
	};
	if (nextEntry.commitSource === null && nextEntry.prSource === null) {
		const { [taskId]: _removed, ...rest } = current;
		return rest;
	}
	return {
		...current,
		[taskId]: nextEntry,
	};
}

/**
 * Check whether a task git action is already in flight.
 */
export function isTaskGitActionInFlight(
	loadingByTaskId: Record<string, TaskGitActionLoadingState>,
	taskId: string,
	actionKey: "commitSource" | "prSource",
): boolean {
	const state = loadingByTaskId[taskId];
	if (!state) {
		return false;
	}
	return state[actionKey] !== null && state[actionKey] !== undefined;
}

// ---------------------------------------------------------------------------
// Error title
// ---------------------------------------------------------------------------

/**
 * Compute a human-readable title for a git action error.
 */
export function getGitActionErrorTitle(error: GitActionErrorState | null): string {
	if (!error) {
		return "Git action failed";
	}
	if (error.action === "fetch") {
		return "Fetch failed";
	}
	if (error.action === "pull") {
		return "Pull failed";
	}
	return "Push failed";
}

// ---------------------------------------------------------------------------
// Success label
// ---------------------------------------------------------------------------

/**
 * Compute the success toast label for a git sync action.
 */
export function getGitSyncSuccessLabel(action: RuntimeGitSyncAction): string {
	if (action === "push") {
		return "Pushed";
	}
	if (action === "pull") {
		return "Pulled";
	}
	return "Fetched";
}
