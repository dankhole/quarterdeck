import type { RuntimeProjectTaskCounts } from "@/runtime/types";

export interface ProjectNavigationTaskCounts {
	backlog: number;
	inProgress: number;
	review: number;
	needsInput: number;
}

/**
 * Combines independent board-column and notification projections.
 *
 * Review is the board-owned total for that column. Needs Input is an
 * overlapping semantic signal from the notification projection, not a
 * replacement column, so it must neither reduce Review nor be clamped to a
 * potentially older board snapshot.
 */
export function resolveProjectNavigationTaskCounts(
	taskCounts: RuntimeProjectTaskCounts,
	requestedNeedsInputCount: number,
): ProjectNavigationTaskCounts {
	return {
		backlog: taskCounts.backlog,
		inProgress: taskCounts.in_progress,
		review: taskCounts.review,
		needsInput: Math.max(0, requestedNeedsInputCount),
	};
}
